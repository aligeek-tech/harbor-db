import type { ConnectionProfile, ConnectionStatus, HistoryEntry } from './contracts'

export function duplicateProfile(profile: ConnectionProfile, id: string): ConnectionProfile {
  return {
    ...profile,
    id,
    name: `${profile.name} copy`.slice(0, 120),
    favorite: false,
    autoReconnect: false,
    hasPassword: false,
    hasSshPassword: false,
    hasPassphrase: false,
    tls: { ...profile.tls, keyPath: '' },
    ssh: { ...profile.ssh, privateKeyPath: '' },
  }
}

export function recentConnectionIds(
  history: HistoryEntry[],
  statuses: Record<string, ConnectionStatus>,
): string[] {
  const timestamps = new Map<string, number>()
  const record = (id: string, value?: string) => {
    const time = value ? Date.parse(value) : NaN
    if (Number.isFinite(time)) timestamps.set(id, Math.max(timestamps.get(id) || 0, time))
  }
  for (const entry of history) record(entry.connectionId, entry.executedAt)
  for (const [id, status] of Object.entries(statuses)) record(id, status.lastConnectedAt)
  return [...timestamps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id)
}
