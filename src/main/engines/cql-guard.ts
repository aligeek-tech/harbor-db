import type { CqlExecute, CqlTable } from '../../shared/cql'
import { CqlInputError } from './cql-values'
interface Token {
  text: string
  quoted: boolean
}
/** Small explicit prepared-CQL grammar, never a claim to parse the full CQL language. */
export function guardCql(input: CqlExecute, table: CqlTable): { cql: string; mutation: boolean } {
  const source = input.cql.trim().replace(/;\s*$/, ''),
    tokens: Token[] = []
  let offset = 0
  while (offset < source.length) {
    const match = /^(?:\s+|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|<=|>=|[.,*?()=<>])/.exec(
      source.slice(offset),
    )
    if (!match)
      throw new CqlInputError(
        'Use supported prepared CQL with ? parameters; comments, string literals and multiple statements are excluded.',
      )
    const value = match[0]
    offset += value.length
    if (!value.trim()) continue
    tokens.push({
      text: value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.toLowerCase(),
      quoted: value.startsWith('"'),
    })
  }
  let position = 0,
    bindings = 0
  const peek = (value: string) => !tokens[position]?.quoted && tokens[position]?.text === value
  const expect = (value: string) => {
    if (!peek(value))
      throw new CqlInputError(
        'Unsupported prepared CQL shape near ' + value + '. Review the generated example.',
      )
    position++
  }
  const identifier = () => {
    const token = tokens[position++]
    if (!token || (!token.quoted && !/^[a-z_][a-z0-9_]*$/.test(token.text)))
      throw new CqlInputError('Expected a CQL identifier.')
    return token.text
  }
  const column = () => {
    const name = identifier()
    if (!table.columns.some((field) => field.name === name))
      throw new CqlInputError('CQL references a column outside the selected table.')
    return name
  }
  const bind = () => {
    expect('?')
    bindings++
  }
  const target = () => {
    const keyspace = identifier()
    expect('.')
    const name = identifier()
    if (keyspace !== table.keyspace || name !== table.name)
      throw new CqlInputError('CQL must target the exact reviewed keyspace and table.')
  }
  const conditions = (allEquality = false) => {
    const result: { name: string; op: string }[] = []
    do {
      const name = column(),
        token = tokens[position++]
      if (!token || token.quoted || !(allEquality ? ['='] : ['=', '<', '<=', '>', '>=']).includes(token.text))
        throw new CqlInputError('Use supported bound comparison conditions.')
      bind()
      result.push({ name, op: token.text })
      if (!peek('and')) break
      position++
    } while (position < tokens.length)
    if (
      new Set(result.filter((x) => x.op === '=').map((x) => x.name)).size !==
      result.filter((x) => x.op === '=').length
    )
      throw new CqlInputError('Equality conditions cannot repeat a column.')
    return result
  }
  const requireKey = (values: { name: string; op: string }[], full: boolean) => {
    const fields = [...table.partition, ...(full ? table.clustering : [])]
    if (fields.some((name) => !values.some((value) => value.name === name && value.op === '=')))
      throw new CqlInputError(
        full
          ? 'Mutations require equality for the complete primary key.'
          : 'Query requires equality for every partition-key column. Enable explicit scan consent for a broader read.',
      )
    if (full && values.some((value) => !fields.includes(value.name)))
      throw new CqlInputError('Mutation WHERE conditions may name primary-key columns only.')
  }
  let mutation = false
  if (peek('select')) {
    expect('select')
    if (peek('*')) position++
    else {
      column()
      while (peek(',')) {
        position++
        column()
      }
    }
    expect('from')
    target()
    let filters: { name: string; op: string }[] = []
    if (peek('where')) {
      position++
      filters = conditions()
    }
    if (!input.allowScan) requireKey(filters, false)
    if (peek('order')) {
      position++
      expect('by')
      do {
        const name = column()
        if (!table.clustering.includes(name))
          throw new CqlInputError('ORDER BY can use clustering columns only.')
        if (peek('asc') || peek('desc')) position++
        if (!peek(',')) break
        position++
      } while (position < tokens.length)
    }
    expect('limit')
    const limit = tokens[position++]
    if (
      !limit ||
      limit.quoted ||
      !/^\d+$/.test(limit.text) ||
      Number(limit.text) < 1 ||
      Number(limit.text) > 1000
    )
      throw new CqlInputError('SELECT needs a literal LIMIT from 1 to 1000.')
    if (peek('allow')) {
      position++
      expect('filtering')
      if (!input.allowScan || !input.allowFiltering)
        throw new CqlInputError(
          'ALLOW FILTERING needs separate explicit scan and filtering consent; it may be expensive.',
        )
    }
  } else if (peek('insert')) {
    mutation = true
    expect('insert')
    expect('into')
    target()
    expect('(')
    const columns = [column()]
    while (peek(',')) {
      position++
      columns.push(column())
    }
    expect(')')
    expect('values')
    expect('(')
    let count = 1
    bind()
    while (peek(',')) {
      position++
      bind()
      count++
    }
    expect(')')
    if (count !== columns.length || new Set(columns).size !== columns.length)
      throw new CqlInputError('INSERT columns and bound values must match without duplicates.')
    requireKey(
      columns.map((name) => ({ name, op: '=' })),
      false,
    )
    if (table.clustering.some((name) => !columns.includes(name)))
      throw new CqlInputError('INSERT requires the complete primary key.')
    expect('if')
    expect('not')
    expect('exists')
  } else if (peek('update')) {
    mutation = true
    expect('update')
    target()
    expect('set')
    const columns: string[] = []
    do {
      const name = column()
      if ([...table.partition, ...table.clustering].includes(name))
        throw new CqlInputError('Primary-key columns cannot be updated.')
      if (table.columns.find((field) => field.name === name)?.type === 'counter')
        throw new CqlInputError('Counter mutations are excluded.')
      columns.push(name)
      expect('=')
      bind()
      if (!peek(',')) break
      position++
    } while (position < tokens.length)
    if (new Set(columns).size !== columns.length) throw new CqlInputError('SET columns cannot repeat.')
    expect('where')
    requireKey(conditions(true), true)
    expect('if')
    conditions(true)
  } else if (peek('delete')) {
    mutation = true
    expect('delete')
    expect('from')
    target()
    expect('where')
    requireKey(conditions(true), true)
    expect('if')
    conditions(true)
  } else
    throw new CqlInputError(
      'Use SELECT, INSERT IF NOT EXISTS, or conditional UPDATE/DELETE for this workspace.',
    )
  if (position !== tokens.length)
    throw new CqlInputError(
      'Unsupported trailing CQL. Batches, TTL, timestamps, functions, administration and transactions are excluded.',
    )
  if (bindings !== input.parameters.length)
    throw new CqlInputError('Typed parameter count must match every ? marker.')
  if (mutation !== (input.mode === 'mutation'))
    throw new CqlInputError('Execution mode does not match the CQL statement.')
  return { cql: source, mutation }
}
