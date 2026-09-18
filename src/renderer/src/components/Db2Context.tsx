import type { ConnectionProfile } from '@shared/contracts'
import { db2Limitation } from '@shared/db2'

export function Db2Context({ profile }: { profile: ConnectionProfile }) {
  if (profile.engine !== 'db2') return null
  return (
    <details className="field-note col-span-full" data-testid="db2-context">
      <summary>Db2 LUW · guarded reads · native runtime required</summary>
      <p>{db2Limitation}</p>
      <p>
        Use a database account limited to the intended schema. Positional parameters use ?. Full query exports
        obey the same type limits. Native server and packaged driver validation are still required for this
        integration.
      </p>
    </details>
  )
}
