import { savedQuerySchema, type HistoryEntry, type SavedQuery } from './contracts'

export interface HistoryFilters {
  connectionId: string
  outcome: '' | 'success' | 'failed' | 'cancelled'
  after: string
  before: string
  minDuration: string
  maxDuration: string
  minRows: string
  maxRows: string
}
export const emptyHistoryFilters: HistoryFilters = {
  connectionId: '',
  outcome: '',
  after: '',
  before: '',
  minDuration: '',
  maxDuration: '',
  minRows: '',
  maxRows: '',
}
export const historyOutcome = (entry: HistoryEntry) =>
  entry.success ? 'success' : entry.error?.startsWith('Cancelled:') ? 'cancelled' : 'failed'

export function historyMatches(entry: HistoryEntry, filters: HistoryFilters): boolean {
  if (filters.connectionId && entry.connectionId !== filters.connectionId) return false
  if (filters.outcome && historyOutcome(entry) !== filters.outcome) return false
  const timestamp = Date.parse(entry.executedAt)
  if (filters.after && timestamp < new Date(`${filters.after}T00:00:00`).getTime()) return false
  if (filters.before) {
    const end = new Date(`${filters.before}T00:00:00`)
    end.setDate(end.getDate() + 1)
    if (timestamp >= end.getTime()) return false
  }
  for (const [value, minimum, maximum] of [
    [entry.durationMs, filters.minDuration, filters.maxDuration],
    [entry.rowCount, filters.minRows, filters.maxRows],
  ] as const) {
    if (minimum !== '' && value < Number(minimum)) return false
    if (maximum !== '' && value > Number(maximum)) return false
  }
  return true
}

export function updateQueryMetadata(
  query: SavedQuery,
  name: string,
  folder: string,
  tags: string,
): SavedQuery {
  return savedQuerySchema.parse({
    ...query,
    name: name.trim(),
    folder: folder.trim(),
    tags: [
      ...new Set(
        tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ],
    updatedAt: new Date().toISOString(),
  })
}
