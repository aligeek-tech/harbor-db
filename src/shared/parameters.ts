import { z } from 'zod'

export const parameterDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['text', 'integer', 'decimal', 'boolean', 'null', 'json', 'timestamp', 'binary']),
  secret: z.boolean().default(false),
}).strict()
export const queryParameterSchema = parameterDefinitionSchema.extend({ value: z.string().max(1000000) })
export type ParameterDefinition = z.infer<typeof parameterDefinitionSchema>
export type QueryParameter = z.infer<typeof queryParameterSchema>

/** Validate without numeric round trips. Identifier substitution is deliberately unsupported. */
export function parameterValue(parameter: QueryParameter): string | boolean | null | Uint8Array {
  const { value, type } = parameter
  const invalid = () => { throw new Error(`Parameter ${parameter.name}: enter a valid ${type} value.`) }
  switch (type) {
    case 'null': return null
    case 'text': return value
    case 'integer': if (!/^[+-]?\d+$/.test(value)) return invalid(); return value
    case 'decimal': if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return invalid(); return value
    case 'boolean': if (!['true', 'false'].includes(value)) return invalid(); return value === 'true'
    case 'json': try { JSON.parse(value) } catch { return invalid() } return value
    case 'timestamp': if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return invalid(); return value
    case 'binary': {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return invalid()
      return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    }
  }
}

export function redactParameterError(message: string, parameters: QueryParameter[] = []): string {
  // A driver can echo transformed/decoded values as well as literal input. Do not
  // attempt incomplete string redaction when any private parameter was supplied.
  if (parameters.some((parameter) => parameter.secret))
    return 'Query failed while using a private parameter. Check parameter types and database permissions.'
  for (const parameter of parameters) {
    if (parameter.secret && parameter.value) message = message.split(parameter.value).join('[redacted parameter]')
  }
  return message
}
