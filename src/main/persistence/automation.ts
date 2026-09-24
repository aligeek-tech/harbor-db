import { randomUUID } from 'node:crypto'
import {
  automationDefinitionSchema,
  automationHostTimeZone,
  automationRunSchema,
  nextDailyRun,
  type AutomationDefinition,
  type AutomationRun,
} from '../../shared/automation'

export interface AutomationRepository {
  automations(): AutomationDefinition[]
  saveAutomation(value: AutomationDefinition): AutomationDefinition
  deleteAutomation(id: string): void
  automationRuns(taskId?: string): AutomationRun[]
  saveAutomationRun(value: AutomationRun): void
}

export interface AutomationOutcome {
  rows?: number
  bytes?: number
  message: string
}

export interface ReviewedAutomationImport {
  sourceId: string
  consentBatchCommits: true
  consentNonTransactionalAppend: true
}

export class AutomationService {
  private running?: { taskId: string; runId: string; controller: AbortController }
  private timer?: NodeJS.Timeout

  constructor(
    private readonly repository: AutomationRepository,
    private readonly execute: (
      task: AutomationDefinition,
      signal: AbortSignal,
      reviewedImport?: ReviewedAutomationImport,
    ) => Promise<AutomationOutcome>,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) clearInterval(this.timer)
    const now = new Date(this.now())
    for (const task of this.repository.automations()) {
      if (
        task.enabled &&
        task.schedule.kind === 'daily' &&
        task.schedule.timeZone !== automationHostTimeZone()
      ) {
        this.repository.saveAutomationRun({
          id: randomUUID(),
          taskId: task.id,
          state: 'failed',
          code: 'schedule-zone-mismatch',
          trigger: 'startup-audit',
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
          message: 'The desktop time zone changed. Harbor disabled this schedule without running it; review and save it again.',
        })
        this.repository.saveAutomation({ ...task, enabled: false, nextRunAt: undefined, updatedAt: now.toISOString() })
        continue
      }
      if (
        task.enabled &&
        task.schedule.kind === 'daily' &&
        task.nextRunAt &&
        new Date(task.nextRunAt).getTime() <= now.getTime()
      ) {
        this.repository.saveAutomationRun({
          id: randomUUID(),
          taskId: task.id,
          state: 'desktop-unavailable',
          code: 'desktop-runtime-unavailable',
          trigger: 'startup-audit',
          startedAt: task.nextRunAt,
          finishedAt: now.toISOString(),
          message: 'The desktop runtime was unavailable at the scheduled time. Harbor did not backfill or replay this job.',
        })
        this.repository.saveAutomation({
          ...task,
          nextRunAt: nextDailyRun(task.schedule, now),
          updatedAt: now.toISOString(),
        })
      }
    }
    this.timer = setInterval(() => { void this.tick().catch(() => {
      // A persistence failure must not cause repeated unattended submissions.
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
    }) }, 30_000)
    this.timer.unref()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.running?.controller.abort('cancelled')
  }

  list(): { definitions: AutomationDefinition[]; runs: AutomationRun[]; runningTaskId?: string } {
    return {
      definitions: this.repository.automations(),
      runs: this.repository.automationRuns(),
      ...(this.running ? { runningTaskId: this.running.taskId } : {}),
    }
  }

  save(raw: unknown): AutomationDefinition {
    const parsed = automationDefinitionSchema.parse(raw)
    const existing = this.repository.automations().find((item) => item.id === parsed.id)
    const now = new Date(this.now())
    const value: AutomationDefinition = {
      ...parsed,
      createdAt: existing?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt:
        parsed.enabled && parsed.schedule.kind === 'daily'
          ? nextDailyRun(parsed.schedule, now)
          : undefined,
    }
    return this.repository.saveAutomation(value)
  }

  delete(id: string): void {
    if (this.running?.taskId === id) throw new Error('Cancel the running task before deleting it.')
    this.repository.deleteAutomation(id)
  }

  async tick(): Promise<void> {
    if (this.running) return
    const now = this.now()
    const due = this.repository
      .automations()
      .find(
        (task) =>
          task.enabled &&
          task.schedule.kind === 'daily' &&
          !!task.nextRunAt &&
          new Date(task.nextRunAt).getTime() <= now,
      )
    if (due) await this.run(due.id, 'schedule')
  }

  run(taskId: string, trigger: 'manual' | 'schedule' = 'manual', reviewedImport?: ReviewedAutomationImport) {
    const task = this.repository.automations().find((item) => item.id === taskId)
    if (!task) throw new Error('This reusable task no longer exists.')
    if (this.running) throw new Error('One reusable task is already running. Wait or cancel it first.')
    const drift = this.disableDriftedSchedule(task, trigger)
    if (drift) return Promise.resolve(drift)
    if (trigger === 'schedule' && !task.enabled) throw new Error('This reusable task is disabled.')
    if (task.target.kind === 'import' && !reviewedImport) {
      const at = new Date(this.now()).toISOString()
      const run: AutomationRun = {
        id: randomUUID(), taskId, state: 'needs-review', code: 'fresh-import-review-required',
        trigger, startedAt: at, finishedAt: at,
        message: 'Import requires a fresh file grant and review for every run. No file was opened and no rows were written.',
      }
      this.repository.saveAutomationRun(run)
      this.advance(task.id)
      return Promise.resolve(run)
    }
    return this.executeRun(task, trigger, reviewedImport)
  }

  cancel(taskId: string): { requested: boolean } {
    if (!this.running || this.running.taskId !== taskId) return { requested: false }
    this.running.controller.abort('cancelled')
    return { requested: true }
  }

  private async executeRun(
    task: AutomationDefinition,
    trigger: 'manual' | 'schedule',
    reviewedImport?: ReviewedAutomationImport,
  ): Promise<AutomationRun> {
    const controller = new AbortController()
    const run: AutomationRun = {
      id: randomUUID(), taskId: task.id, state: 'running', code: 'started', trigger,
      startedAt: new Date(this.now()).toISOString(), message: 'Reusable task started in the desktop runtime.',
    }
    this.running = { taskId: task.id, runId: run.id, controller }
    try {
      this.repository.saveAutomationRun(run)
    } catch (error) {
      this.running = undefined
      throw error
    }
    const timer = setTimeout(() => controller.abort('resource-limit'), task.limits.maxDurationMs)
    timer.unref()
    try {
      const outcome = await this.execute(task, controller.signal, reviewedImport)
      if (controller.signal.aborted) throw new Error('The reusable task was cancelled before completion.')
      if ((outcome.rows ?? 0) > task.limits.maxRows || (outcome.bytes ?? 0) > task.limits.maxOutputBytes)
        throw new Error('The reusable task exceeded its configured row or byte limit.')
      Object.assign(run, {
        state: 'completed', code: 'completed', finishedAt: new Date(this.now()).toISOString(),
        rows: outcome.rows, bytes: outcome.bytes, message: 'Reusable task completed. Only bounded counts are retained in this log.',
      })
    } catch {
      const limited = controller.signal.reason === 'resource-limit'
      Object.assign(run, {
        state: controller.signal.aborted && !limited ? 'cancelled' : 'failed',
        code: limited ? 'resource-limit' : controller.signal.aborted ? 'cancelled' : 'failed',
        finishedAt: new Date(this.now()).toISOString(),
        message: limited
          ? 'The reusable task reached its configured duration limit and was cancelled. Inspect partial or uncertain outcomes before retrying.'
          : '[redacted] Reusable task failed or was cancelled. Provider details and data are omitted. Inspect the destination and any partial or uncertain outcomes before retrying.',
      })
    } finally {
      clearTimeout(timer)
      try {
        this.repository.saveAutomationRun(automationRunSchema.parse(run))
      } finally {
        this.running = undefined
      }
      this.advance(task.id)
    }
    return automationRunSchema.parse(run)
  }

  private disableDriftedSchedule(task: AutomationDefinition, trigger: AutomationRun['trigger']): AutomationRun | undefined {
    if (task.schedule.kind !== 'daily' || task.schedule.timeZone === automationHostTimeZone()) return
    const at = new Date(this.now()).toISOString()
    // Disable before persisting the log: a logging failure must not leave this eligible to run.
    this.repository.saveAutomation({...task,enabled:false,nextRunAt:undefined,updatedAt:at})
    const run: AutomationRun = {id:randomUUID(),taskId:task.id,state:'failed',code:'schedule-zone-mismatch',trigger,startedAt:at,finishedAt:at,message:'The desktop time zone changed. Schedule disabled; review and save it again. No new work was submitted.'}
    this.repository.saveAutomationRun(run)
    return run
  }

  private advance(taskId: string): void {
    const task = this.repository.automations().find((item) => item.id === taskId)
    if (task?.enabled && task.schedule.kind === 'daily') {
      if(this.disableDriftedSchedule(task, 'schedule')) return
      const now = new Date(this.now())
      this.repository.saveAutomation({
        ...task,
        nextRunAt: nextDailyRun(task.schedule, now),
        updatedAt: now.toISOString(),
      })
    }
  }
}
