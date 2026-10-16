// The schema form: Console form fields from an object JSON Schema, their defaults, value summaries, and validation
// copy. Content documents use it for their properties; any Console section with a JSON Schema can use it too.

/** One invalid field value at a field path, as an owner validator reports it, such as Content's `CONTENT_INVALID`. */
export interface ConsoleFieldIssue {
  field?: string
  message: string
  path: Array<string | number>
}
/** Groups field issues by the dotted path of the form field they belong to, such as `author.name` or `tags`. */
export function groupConsoleFieldIssues(issues: readonly ConsoleFieldIssue[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const issue of issues) {
    const key = [issue.field, ...issue.path.filter(segment => String(segment) === segment)].filter(segment => segment !== undefined).join(".") || ""
    ;(grouped[key] ??= []).push(issue.message)
  }
  return grouped
}

export type ConsoleSchemaFieldKind =
  | "blob"
  | "boolean"
  | "date"
  | "date-time"
  | "enum"
  | "integer"
  | "json"
  | "number"
  | "object"
  | "string"
  | "string-list"
  | "text"

export interface ConsoleSchemaField {
  description?: string
  enum?: Array<string | number>
  /** Child fields of an `object` field. */
  fields?: ConsoleSchemaField[]
  format?: string
  kind: ConsoleSchemaFieldKind
  label: string
  maxLength?: number
  maximum?: number
  minimum?: number
  name: string
  required: boolean
  schema: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function schemaTypes(schema: Record<string, unknown>): string[] {
  const type = schema.type
  if (String(type) === type) return [type]
  return Array.isArray(type) ? type.filter((entry): entry is string => String(entry) === entry) : []
}

/** Unwraps `anyOf`/`oneOf` with a `null` branch, which optional fields often produce. */
function nonNullSchema(schema: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = Array.isArray(schema[key]) ? schema[key].map(record).filter(option => option !== undefined) : []
    const present = options.filter(option => !schemaTypes(option).every(type => type === "null"))
    if (!options.length || present.length !== 1) continue
    // Keep the title and description of the optional wrapper.
    const unwrapped = { ...present[0] }
    if (schema.description) unwrapped.description = schema.description
    if (schema.title) unwrapped.title = schema.title
    return unwrapped
  }
  return schema
}

/** `publishedAt` → `Published at`. */
export function consoleFieldLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : name
}

function fieldKind(schema: Record<string, unknown>): ConsoleSchemaFieldKind {
  if (record(schema["x-vitehub-blob"])) return "blob"
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.every(value => String(value) === value || Number.isFinite(value))) return "enum"
  const types = schemaTypes(schema).filter(type => type !== "null")
  const type = types.length === 1 ? types[0] : undefined
  if (type === "string") {
    if (schema.format === "date") return "date"
    if (schema.format === "date-time") return "date-time"
    // Long limits suggest prose, such as a summary.
    return Number(schema.maxLength) > 200 ? "text" : "string"
  }
  if (type === "number") return "number"
  if (type === "integer") return "integer"
  if (type === "boolean") return "boolean"
  if (type === "array") {
    const items = record(schema.items)
    const itemTypes = items ? schemaTypes(items) : []
    // Tags edit plain text, so formats that are plain text too, such as URLs and emails, stay tags.
    const textFormat = items?.format === undefined || ["email", "uri", "url"].includes(String(items.format))
    if (items && itemTypes.length === 1 && itemTypes[0] === "string" && !items.enum && textFormat) return "string-list"
    return "json"
  }
  if (type === "object" && record(schema.properties)) return "object"
  return "json"
}

/** Describes the form fields of an object JSON Schema, in property order. Unknown shapes become JSON fields. */
export function describeConsoleSchemaFields(schema: Record<string, unknown>): ConsoleSchemaField[] {
  const properties = record(schema.properties) ?? {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(name => String(name) === name) : [])
  return Object.entries(properties).map(([name, value]) => {
    const property = nonNullSchema(record(value) ?? {})
    const kind = fieldKind(property)
    const field: ConsoleSchemaField = {
      kind,
      label: String(property.title) === property.title && property.title ? property.title : consoleFieldLabel(name),
      name,
      required: required.has(name),
      schema: property,
    }
    if (String(property.description) === property.description) field.description = property.description
    if (String(property.format) === property.format) field.format = property.format
    if (kind === "enum" && Array.isArray(property.enum)) field.enum = property.enum.filter(option => String(option) === option || Number.isFinite(option))
    for (const key of ["minimum", "maximum", "maxLength"] as const) {
      const number = Number(property[key])
      if (property[key] !== undefined && Number.isFinite(number)) field[key] = number
    }
    if (kind === "object") field.fields = describeConsoleSchemaFields(property)
    return field
  })
}

/** Initial values for a new document: each field's JSON Schema default, or nothing. */
export function consoleSchemaDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of describeConsoleSchemaFields(schema)) {
    if (field.schema.default !== undefined) values[field.name] = JSON.parse(JSON.stringify(field.schema.default))
    else if (field.kind === "boolean" && field.required) values[field.name] = false
    else if (field.kind === "object" && field.required) values[field.name] = consoleSchemaDefaults(field.schema)
  }
  return values
}

/** Removes empty optional values, so a cleared input does not save an empty string over a missing field. */
export function compactConsoleFieldValues(fields: readonly ConsoleSchemaField[], values: Record<string, unknown>): Record<string, unknown> {
  const result = { ...values }
  for (const field of fields) {
    const value = result[field.name]
    if (field.kind === "object" && field.fields && record(value)) {
      const nested = compactConsoleFieldValues(field.fields, record(value)!)
      // An optional object that the editor left empty is absent, not `{}` with missing required keys.
      const empty = Object.values(nested).every(entry => entry === "" || entry === undefined || entry === null)
      if (empty && !field.required) delete result[field.name]
      else result[field.name] = nested
      continue
    }
    if (field.required) continue
    if (value === "" || value === null || value === undefined) delete result[field.name]
  }
  return result
}

/**
 * One line that summarises a field value, such as `London · GB · 51.5, -0.12` for a place with a nested position. Each
 * child of an object joins with ` · `, a nested object or a list joins with `, `, a switch that is on shows its label,
 * and a Blob reference shows its file name. Empty values are left out, and an empty result is `""`.
 */
export function consoleValueSummary(field: Pick<ConsoleSchemaField, "fields" | "kind" | "label"> | undefined, value: unknown, nested = false): string {
  if (value === undefined || value === null) return ""
  if (String(value) === value) return value.trim()
  if (Number.isFinite(value)) return String(value)
  if (value === true || value === false) return value && field ? field.label : value ? "Yes" : ""
  if (Array.isArray(value)) return value.map(entry => consoleValueSummary(undefined, entry, true)).filter(Boolean).join(", ")
  const object = record(value)
  if (!object) return ""
  const pathname = object.pathname
  if (field?.kind === "blob" || (String(pathname) === pathname && pathname)) return String(pathname) === pathname ? pathname.slice(pathname.lastIndexOf("/") + 1) : ""
  const parts = field?.fields
    ? field.fields.map(child => consoleValueSummary(child, object[child.name], true))
    : Object.values(object).map(entry => consoleValueSummary(undefined, entry, true))
  return parts.filter(Boolean).join(nested ? ", " : " · ")
}

// Field validation copy: the field name and the constraint, such as `Name is required.` (Geist input).

/**
 * Rewrites a validator message as the field name plus the constraint. Messages from Standard Schema validators, such
 * as `Invalid input: expected string, received undefined`, read as raw types; unknown messages keep their own words.
 */
export function consoleFieldIssueMessage(label: string, message: string): string {
  const text = message.trim()
  if (/received (undefined|null)\b|^required\b|\bis required\b|^invalid input$/i.test(text)) return `${label} is required.`
  const bound = /(<=?|>=?)\s*(\d+(?:\.\d+)?)/.exec(text)
  if (bound && /too big|too small|invalid (length|size|value)|maximum|minimum/i.test(text)) {
    const unit = /\bstrings?\b|characters?/i.test(text) ? " characters" : /\barrays?\b|items?|elements?/i.test(text) ? " items" : ""
    const limit = { "<": "less than", "<=": "at most", ">": "more than", ">=": "at least" }[bound[1]!]
    return `${label} must be ${limit} ${bound[2]}${unit}.`
  }
  if (/\burl\b/i.test(text)) return `${label} must be a valid URL.`
  if (/\bemail\b/i.test(text)) return `${label} must be a valid email address.`
  if (/\b(date|datetime|iso)\b/i.test(text)) return `${label} must be a valid date.`
  if (/invalid option|expected one of|invalid enum/i.test(text)) return `${label} must be one of the listed options.`
  const type = /expected (string|number|boolean|array|object|integer)/i.exec(text)
  if (type) {
    const noun = { array: "a list", boolean: "on or off", integer: "a whole number", number: "a number", object: "a group of fields", string: "text" }[type[1]!.toLowerCase()]
    return `${label} must be ${noun}.`
  }
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** Rewrites the message of each field issue with the label of the field it belongs to, such as `Author name is required.` */
export function humanizeConsoleFieldIssues(fields: readonly ConsoleSchemaField[], issues: readonly ConsoleFieldIssue[]): ConsoleFieldIssue[] {
  return issues.map((issue) => {
    const path = [issue.field, ...issue.path.filter(segment => String(segment) === segment)].filter(segment => segment !== undefined)
    let level: readonly ConsoleSchemaField[] | undefined = fields
    const labels: string[] = []
    for (const name of path) {
      const field: ConsoleSchemaField | undefined = level?.find(entry => entry.name === name)
      if (!field) break
      labels.push(field.label)
      level = field.fields
    }
    if (!labels.length) return issue
    // A nested field names its parent too, so `Name` under Author reads `Author name`.
    const label = labels.length > 1 ? `${labels.at(-2)} ${labels.at(-1)!.toLowerCase()}` : labels[0]!
    return { ...issue, message: consoleFieldIssueMessage(label, issue.message) }
  })
}

function emptyValue(value: unknown): boolean {
  return value === undefined || value === null || (String(value) === value && !value.trim()) || (Array.isArray(value) && !value.length)
}

/**
 * Checks one field value against the constraints the form can read from its JSON Schema, for validation on blur. The
 * owner validators still run on save and stay the source of truth.
 */
export function consoleFieldValueIssue(field: ConsoleSchemaField, value: unknown): string | undefined {
  if (field.kind === "object" || field.kind === "blob" || field.kind === "json") return undefined
  if (emptyValue(value)) return field.required && field.kind !== "boolean" ? `${field.label} is required.` : undefined
  if ((field.kind === "string" || field.kind === "text") && String(value) === value) {
    if (field.maxLength !== undefined && value.length > field.maxLength) return `${field.label} must be at most ${field.maxLength} characters.`
    const minLength = Number(field.schema.minLength)
    if (Number.isFinite(minLength) && value.length < minLength) return `${field.label} must be at least ${minLength} characters.`
    if (field.format === "uri" || field.format === "url") {
      try {
        new URL(value)
      }
      catch {
        return `${field.label} must be a valid URL.`
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `${field.label} must be a valid email address.`
  }
  if ((field.kind === "number" || field.kind === "integer") && Number(value) === value) {
    if (field.kind === "integer" && !Number.isInteger(value)) return `${field.label} must be a whole number.`
    if (field.minimum !== undefined && value < field.minimum) return `${field.label} must be at least ${field.minimum}.`
    if (field.maximum !== undefined && value > field.maximum) return `${field.label} must be at most ${field.maximum}.`
  }
  return undefined
}
