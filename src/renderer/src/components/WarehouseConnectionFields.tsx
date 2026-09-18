import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function WarehouseConnectionFields({
  profile,
  update,
}: {
  profile: ConnectionProfile
  update: (value: Partial<ConnectionProfile>) => void
}) {
  const snow = profile.engine === 'snowflake'
  return (
    <>
      <Field>
        <FieldLabel htmlFor="warehouse-name">
          {snow ? 'Snowflake warehouse name' : 'Databricks SQL warehouse ID'}
        </FieldLabel>
        <Input
          id="warehouse-name"
          value={profile.warehouse.warehouse}
          onChange={(event) => update({ warehouse: { ...profile.warehouse, warehouse: event.target.value } })}
        />
      </Field>
      {snow && (
        <>
          <Field>
            <FieldLabel htmlFor="warehouse-role">Snowflake role (optional)</FieldLabel>
            <Input
              id="warehouse-role"
              value={profile.warehouse.role}
              onChange={(event) => update({ warehouse: { ...profile.warehouse, role: event.target.value } })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="warehouse-token">Snowflake token type</FieldLabel>
            <select
              id="warehouse-token"
              value={profile.warehouse.snowflakeTokenType}
              onChange={(event) =>
                update({
                  warehouse: {
                    ...profile.warehouse,
                    snowflakeTokenType: event.target
                      .value as ConnectionProfile['warehouse']['snowflakeTokenType'],
                  },
                })
              }
            >
              <option value="OAUTH">OAuth access token</option>
              <option value="PROGRAMMATIC_ACCESS_TOKEN">Programmatic access token</option>
              <option value="KEYPAIR_JWT">Already generated key-pair JWT</option>
            </select>
          </Field>
        </>
      )}
      <p className="field-note full-field">
        Use an official {snow ? 'account.snowflakecomputing.com' : 'Databricks workspace'} hostname and an
        explicitly scoped access token. Verified TLS is required. Harbor never creates or starts a warehouse
        and never refreshes tokens automatically. Browsing catalogs uses native metadata SQL and may use
        warehouse compute; connecting and browsing authorizes those metadata reads. Every user query opens a
        warehouse/cost review. Opening a table only creates an inert query draft.
      </p>
      <p className="field-note full-field">
        {snow
          ? 'Direct paged results retain exact typed values and use bounded gzip decoding. Full read-only result export runs a separate reviewed statement.'
          : 'Only an already RUNNING SQL warehouse is queried. Results use INLINE JSON with an explicit16MiB limit; external storage links and full-result streaming export are unavailable.'}{' '}
        No interactive transactions or grid editing. Native service acceptance is pending an authorized
        disposable account; local protocol checks do not establish compatibility.
      </p>
    </>
  )
}
