import { _electron, expect, test, type ElectronApplication, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { profileSchema } from '../src/shared/contracts'
import { waitForElectronWorkspace } from './electron-runtime'

async function executeReview(dialog: Locator, outcome = 'committed') {
  const review = dialog.getByRole('region', { name: 'Administration command review', exact: true })
  const execute = dialog.getByRole('button', { name: 'Execute reviewed administration command', exact: true })
  await expect(execute).toBeDisabled()
  await dialog.getByLabel('Administration target confirmation', { exact: true }).fill('wrong target')
  await expect(execute).toBeDisabled()
  await dialog
    .getByLabel('Administration target confirmation', { exact: true })
    .fill(await review.locator('strong').innerText())
  await execute.click()
  await expect(dialog.getByRole('status')).toContainText(`Administration outcome: ${outcome}`)
}
for (const timescale of [false, true])
  test(
    timescale
      ? 'Timescale policy form creates a reviewed future job, pauses and removes it'
      : 'SQL administration UI inspects explicitly, reviews table privileges and cancels one native query',
    async () => {
      test.skip(
        timescale ? process.env.HARBOR_TIMESCALE !== '1' : process.env.HARBOR_INTEGRATION !== '1',
        'Requires disposable native PostgreSQL fixtures.',
      )
      const directory = await mkdtemp(join(tmpdir(), 'harbor-administration-ui-')),
        suffix = randomUUID().replaceAll('-', '').slice(0, 12),
        table = `admin_ui_${suffix}`,
        role = `admin_ui_role_${suffix}`
      const port = timescale ? 15433 : 15432,
        options = { host: '127.0.0.1', port, user: 'harbor', password: 'harbor_test', database: 'harbor' }
      const client = new Client(options),
        worker = new Client(options)
      let desktop: ElectronApplication | undefined
      await client.connect()
      try {
        await client.query(
          `CREATE TABLE public."${table}"(${timescale ? 'time timestamptz NOT NULL,' : ''}id integer PRIMARY KEY${timescale ? ', UNIQUE(time,id)' : ''})`.replace(
            'id integer PRIMARY KEY',
            timescale ? 'id integer' : 'id integer PRIMARY KEY',
          ),
        )
        if (timescale)
          await client.query('SELECT create_hypertable($1::regclass,$2::name)', [`public.${table}`, 'time'])
        else await client.query(`CREATE ROLE "${role}" NOLOGIN`)
        const profile = profileSchema.parse({
          id: randomUUID(),
          name: timescale ? 'Reviewed Timescale UI' : 'Reviewed administration UI',
          engine: 'postgres',
          host: '127.0.0.1',
          port,
          username: 'harbor',
          database: 'harbor',
          schema: 'public',
          readOnly: false,
        })
        const root = resolve(import.meta.dirname, '..'),
          env = Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
            ),
          )
        desktop = await _electron.launch({
          chromiumSandbox: true,
          args: [root],
          cwd: root,
          env: { ...env, HARBOR_USER_DATA: directory },
        })
        const page = await desktop.firstWindow()
        await waitForElectronWorkspace(page)
        await page.evaluate(
          async (profile) =>
            window.harbor.saveProfile({
              profile,
              secrets: { password: 'harbor_test' },
              rememberPassword: false,
            }),
          profile,
        )
        await page.reload()
        await waitForElectronWorkspace(page)
        await page.getByRole('button', { name: profile.name, exact: true }).dblclick()
        await expect(page.getByLabel(`${profile.name}: connected`, { exact: true })).toBeVisible()
        await page.getByRole('button', { name: 'New query', exact: true }).first().click()
        await page.getByRole('button', { name: 'Inspect database activity', exact: true }).click()
        await page
          .getByRole('dialog', { name: 'Database diagnostics', exact: true })
          .getByRole('button', { name: 'SQL administration', exact: true })
          .click()
        const dialog = page.getByRole('dialog', { name: 'SQL administration', exact: true })
        await expect(
          dialog.getByRole('region', { name: 'Administration snapshot', exact: true }),
        ).toHaveCount(0)
        await dialog.getByLabel('Administration table', { exact: true }).fill(table)
        if (timescale) {
          await dialog.getByLabel('Administration view', { exact: true }).selectOption('timescale')
          await dialog.getByRole('button', { name: 'Load administration snapshot', exact: true }).click()
          await expect(
            dialog.getByRole('region', { name: 'Administration snapshot', exact: true }),
          ).toContainText('TimescaleDB')
          await dialog.getByLabel('Policy age hours', { exact: true }).fill('48')
          const future = new Date(Date.now() + 86400000),
            local = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
          await dialog.getByLabel('Policy future start', { exact: true }).fill(local)
          await dialog.getByRole('button', { name: 'Preview policy command', exact: true }).click()
          await expect(
            dialog.getByRole('region', { name: 'Administration command review', exact: true }),
          ).toContainText('add_retention_policy')
          expect(
            (
              await client.query('SELECT job_id FROM timescaledb_information.jobs WHERE hypertable_name=$1', [
                table,
              ])
            ).rowCount,
          ).toBe(0)
          await executeReview(dialog)
          const jobId = (
            await client.query('SELECT job_id FROM timescaledb_information.jobs WHERE hypertable_name=$1', [
              table,
            ])
          ).rows[0].job_id
          await dialog.getByLabel('Existing policy job ID', { exact: true }).fill(String(jobId))
          await dialog.getByRole('button', { name: 'Preview job schedule', exact: true }).click()
          await executeReview(dialog)
          expect(
            (
              await client.query('SELECT scheduled FROM timescaledb_information.jobs WHERE job_id=$1', [
                jobId,
              ])
            ).rows[0].scheduled,
          ).toBe(false)
          await dialog.getByLabel('Timescale policy action', { exact: true }).selectOption('remove')
          await dialog.getByRole('button', { name: 'Preview policy command', exact: true }).click()
          await executeReview(dialog)
          expect(
            (await client.query('SELECT job_id FROM timescaledb_information.jobs WHERE job_id=$1', [jobId]))
              .rowCount,
          ).toBe(0)
        } else {
          await dialog.getByLabel('Administration view', { exact: true }).selectOption('permissions')
          await dialog.getByLabel('Existing principal', { exact: true }).fill(role)
          await dialog.getByRole('button', { name: 'Preview privilege command', exact: true }).click()
          expect(
            (
              await client.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed", [
                role,
                `public.${table}`,
              ])
            ).rows[0].allowed,
          ).toBe(false)
          await executeReview(dialog)
          expect(
            (
              await client.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed", [
                role,
                `public.${table}`,
              ])
            ).rows[0].allowed,
          ).toBe(true)
          await dialog.getByLabel('Privilege action', { exact: true }).selectOption('revoke')
          await dialog.getByRole('button', { name: 'Preview privilege command', exact: true }).click()
          await executeReview(dialog)
          expect(
            (
              await client.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed", [
                role,
                `public.${table}`,
              ])
            ).rows[0].allowed,
          ).toBe(false)
          await worker.connect()
          const pid = (await worker.query('SELECT pg_backend_pid() AS id')).rows[0].id
          const sleeping = worker.query('SELECT pg_sleep(25)').then(
            () => false,
            () => true,
          )
          await dialog.getByLabel('Administration view', { exact: true }).selectOption('sessions')
          await dialog.getByRole('button', { name: 'Load administration snapshot', exact: true }).click()
          await dialog.getByRole('button', { name: `Review cancel ${pid}`, exact: true }).click()
          await expect(
            dialog.getByRole('region', { name: 'Administration command review', exact: true }),
          ).toContainText(`Session: ${pid}`)
          await executeReview(dialog, 'requested')
          expect(await sleeping).toBe(true)
          expect((await worker.query('SELECT 1 AS connected')).rows[0].connected).toBe(1)
        }
        expect((await page.evaluate(() => window.harbor.bootstrap())).history).toHaveLength(0)
      } finally {
        await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
        await desktop?.close()
        await worker.end().catch(() => undefined)
        await client.query(`DROP TABLE IF EXISTS public."${table}"`).catch(() => undefined)
        if (!timescale) await client.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined)
        await client.end()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
