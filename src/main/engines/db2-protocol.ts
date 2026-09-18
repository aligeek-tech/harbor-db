import type { Cell, ResultColumn, ResultSet } from '../../shared/contracts'
import type { Db2Encoding } from './db2-values'

export type Db2Parameter = string | number | boolean | null | { binary: string }
export type Db2Request =
  | { id: number; action: 'open'; connectionString: string; timeout: number }
  | {
      id: number
      action: 'query'
      sql: string
      parameters: Db2Parameter[]
      maxRows: number
      timeout: number
      encodings?: Db2Encoding[]
      stream?: boolean
    }
  | { id: number; action: 'ack'; target: number }
  | { id: number; action: 'close' }
export interface Db2Response {
  id: number
  error?: string
  fatal?: boolean
  version?: string
  set?: ResultSet
  stream?: { columns?: ResultColumn[]; row?: Cell[] }
}
