import { Worker } from 'node:worker_threads'
import type { Cell, ResultColumn } from '../../shared/contracts'

export interface ExportData {
  format: 'csv' | 'json'
  columns: ResultColumn[]
  rows: Cell[][]
  spreadsheetSafe: boolean
  scope: string
}
/** JSON uses ordered columns/rows, retaining duplicate names, NULL, binary and exact text numbers. */
export function exportLoadedData(path: string, data: ExportData): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const { workerData, parentPort } = module['require']('node:worker_threads');
      const fs = module['require']('node:fs');
      const { path, data } = workerData;
      function csv(value) {
        if(value === null) return String.fromCharCode(92) + 'N';
        let text = typeof value === 'object' ? 'base64:' + value.base64 : String(value);
        if(data.spreadsheetSafe && /^[=+@\\-\\t\\r]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
      }
      (async () => {
        const stream = fs.createWriteStream(path, {mode: 0o600});
        const write = text => new Promise((resolve,reject) => stream.write(text, error => error ? reject(error) : resolve()));
        stream.on('error', error => parentPort.postMessage({error:error.message}));
        if(data.format === 'json') {
          await write('{"format":"harbor-db-results","version":1,"scope":' + JSON.stringify(data.scope) + ',"columns":' + JSON.stringify(data.columns) + ',"rows":[\\n');
          for(let i=0;i<data.rows.length;i++) await write((i ? ',\\n' : '') + JSON.stringify(data.rows[i]));
          await write('\\n]}\\n');
        } else {
          await write(data.columns.map(column=>csv(column.name)).join(',') + '\\r\\n');
          for(const row of data.rows) await write(row.map(csv).join(',') + '\\r\\n');
        }
        await new Promise((resolve,reject)=>stream.end(error=>error ? reject(error) : resolve()));
        parentPort.postMessage({ok:true});
      })().catch(error=>parentPort.postMessage({error:error.message}));
    `,
      { eval: true, workerData: { path, data } },
    )
    worker.once('message', (result: { ok?: boolean; error?: string }) => {
      void worker.terminate()
      if (result.ok) resolve()
      else reject(new Error(result.error || 'Export failed'))
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0 && code !== 1) reject(new Error(`Export worker exited (${code}).`))
    })
  })
}
