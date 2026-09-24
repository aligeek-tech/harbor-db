import type { EditsInput } from '@shared/contracts'
import { displayCell } from '../lib/utils'

export function PendingChanges({ changes, target }: { changes: EditsInput['changes']; target: string }) {
  const counts = {insert:0,update:0,delete:0}
  for(const change of changes) counts[change.kind]++
  const missingOriginal = changes.filter(change=>change.kind !== 'insert' && (!change.original || Object.keys(change.original).length === 0)).length
  return <details open className="border-b px-3 py-2 max-h-64 overflow-auto" aria-label="Pending changes tray">
    <summary>Pending changes · {target}</summary>
    <p role="status" aria-live="polite">{counts.insert} inserts · {counts.update} updates · {counts.delete} deletes</p>
    <p className="field-note">{missingOriginal ? `${missingOriginal} proposals have no original values; refresh and review their conflict protection.` : 'Original-value snapshots are present for existing rows.'} Database constraints and permissions are validated when you apply.</p>
    <p className="field-note">Local proposals only. Review &amp; apply checks original values in the same tab’s database session.
      A conflict leaves these proposals available for review; nothing is replayed automatically.</p>
    {changes.map((change, index) => <section key={index} className="my-2 border rounded p-2" aria-label={`${change.kind} proposal ${index + 1}`}>
      <strong>{change.kind.toUpperCase()} · {index + 1}</strong>
      <table className="data-grid"><thead><tr><th>Column</th><th>Original</th><th>Proposed</th></tr></thead>
        <tbody>{Object.keys(change.kind === 'delete' ? change.original || {} : change.values).map((column) => <tr key={column}>
          <th>{column}</th><td className="whitespace-pre-wrap break-all">{change.kind === 'insert' ? 'New row' : displayCell(change.original?.[column]) || '(empty string)'}</td>
          <td className="whitespace-pre-wrap break-all">{change.kind === 'delete' ? 'Delete row' : displayCell(change.values[column]) || '(empty string)'}</td>
        </tr>)}</tbody>
      </table>
    </section>)}
  </details>
}
