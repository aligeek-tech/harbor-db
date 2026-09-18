import { describe, it, expect } from 'vitest'
import { influxSets, questSet, seriesJson } from '../src/main/engines/series-values'
import {
  fluxBrowse,
  fluxString,
  questIdentifier,
  seriesQuerySchema,
  instantNanos,
} from '../src/shared/time-series'
const query = () =>
  seriesQuerySchema.parse({
    connectionId: 'test',
    sessionId: 'tab',
    requestId: crypto.randomUUID(),
    source: 'metrics',
    measurement: 'cpu',
    start: '2026-01-01T00:00:00.000000001Z',
    stop: '2026-01-02T00:00:00Z',
    tags: [{ key: 'host', value: 'a"\\b' }],
  })
describe('native time-series representations and safeguards', () => {
  it('compares nanosecond ranges exactly and rejects normalized invalid dates', () => {
    expect(
      instantNanos('2026-01-01T00:00:00.000000002Z') - instantNanos('2026-01-01T00:00:00.000000001Z'),
    ).toBe(1n)
    expect(() => instantNanos('2026-02-30T00:00:00Z')).toThrow('calendar')
    expect(seriesQuerySchema.parse({ ...query(), stop: '2026-01-01T00:00:00.000000002Z' }).stop).toContain(
      '000000002',
    )
  })
  it('preserves annotated group identity, uint64, nanosecond timestamps, quoted newlines and empty strings', () => {
    const csv =
      '#datatype,string,long,dateTime:RFC3339,long,unsignedLong,string\n#group,false,false,false,false,false,true\n#default,_result,,,,,\n,result,table,_time,signed,unsigned,label\n,,0,2026-01-01T00:00:00.123456789Z,-9223372036854775808,18446744073709551615,"a,b\nline"\n,,1,2026-01-01T00:00:00.123456790Z,0,0,""\n'
    const result = influxSets(csv, 10)
    expect(result.sets).toHaveLength(2)
    expect(result.sets[0].rows[0]).toEqual([
      '_result',
      '0',
      '2026-01-01T00:00:00.123456789Z',
      '-9223372036854775808',
      '18446744073709551615',
      'a,b\nline',
    ])
    expect(result.sets[1].rows[0][5]).toBe('')
    expect(result.sets[0].group).toEqual({ label: 'a,b\nline' })
  })
  it('discards an HTTP200 late error and never echoes canary server data', () => {
    expect(() => influxSets('#datatype,string,long\n,error,reference\n,PRIVATE_TOKEN,1\n', 2)).toThrow(
      'Partial results are discarded',
    )
    try {
      influxSets('#datatype,string,long\n,error,reference\n,PRIVATE_TOKEN,1\n', 2)
    } catch (e) {
      expect(String(e)).not.toContain('PRIVATE_TOKEN')
    }
    expect(() => seriesJson('{"PRIVATE_TOKEN":')).toThrow('contents are omitted')
  })
  it('enforces a global row cap across series and rejects malformed/incomplete CSV', () => {
    const csv = '#datatype,string,long,long\n#default,_result,,\n,result,table,_value\n,,0,1\n,,1,2\n'
    expect(influxSets(csv, 1).truncated).toBe(true)
    expect(influxSets(csv, 1).sets).toHaveLength(1)
    expect(() => influxSets(csv + '"unfinished', 2)).toThrow('Incomplete')
    expect(() => influxSets('#datatype,string\n,x,y\n', 2)).toThrow('annotations')
  })
  it('keeps QuestDB numbers as exact text and refuses HTTP binary omission', () => {
    const set = questSet(
      seriesJson(
        '{"columns":[{"name":"n","type":"LONG"},{"name":"d","type":"DECIMAL(38,18)"}],"dataset":[[9223372036854775807,12345678901234567890.123456789012345678]]}',
      ),
    )
    expect(set.rows[0]).toEqual(['9223372036854775807', '12345678901234567890.123456789012345678'])
    expect(() => questSet({ columns: [{ name: 'b', type: 'BINARY' }], dataset: [[null]] })).toThrow('BINARY')
    expect(() => questSet({ unexpected: 'OK' })).toThrow('acknowledge')
  })
  it('builds bounded Flux without accepting interpolation or code fragments', () => {
    const sql = fluxBrowse(query())
    expect(sql).toContain('limit(n: 201)')
    expect(sql).toContain('time(v: "2026-01-01T00:00:00.000000001Z")')
    expect(sql).toContain('r["host"] == "a\\"\\\\b"')
    expect(() => fluxString('${http.post(url:"remote")}')).toThrow('interpolation')
    expect(questIdentifier('a";drop table x;--')).toBe('"a"";drop table x;--"')
    expect(() => seriesQuerySchema.parse({ ...query(), stop: query().start })).toThrow()
  })
})
