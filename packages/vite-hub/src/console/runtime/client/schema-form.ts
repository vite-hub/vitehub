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
  | "list"
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
  /** For an object that holds an image, such as `{ src, alt }`: the names of its source and alternative text fields. */
  image?: { alt?: string, src: string }
  /** The field of each item of a `list` field. */
  item?: ConsoleSchemaField
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
    // Any other item with a shape, such as a link object or a date, edits as a list of those fields.
    return items && fieldKind(nonNullSchema(items)) !== "json" ? "list" : "json"
  }
  if (type === "object" && record(schema.properties)) return "object"
  return "json"
}

function describeField(name: string, value: unknown, required: boolean, label?: string): ConsoleSchemaField {
  const property = nonNullSchema(record(value) ?? {})
  const kind = fieldKind(property)
  const field: ConsoleSchemaField = {
    kind,
    label: String(property.title) === property.title && property.title ? property.title : label ?? consoleFieldLabel(name),
    name,
    required,
    schema: property,
  }
  if (String(property.description) === property.description) field.description = property.description
  if (String(property.format) === property.format) field.format = property.format
  if (kind === "enum" && Array.isArray(property.enum)) field.enum = property.enum.filter(option => String(option) === option || Number.isFinite(option))
  for (const key of ["minimum", "maximum", "maxLength"] as const) {
    const number = Number(property[key])
    if (property[key] !== undefined && Number.isFinite(number)) field[key] = number
  }
  if (kind === "object") {
    field.fields = describeConsoleSchemaFields(property)
    // `{ src, alt }` holds an image by its URL, so the form can show it.
    const text = (child: string) => field.fields!.find(entry => entry.name === child && (entry.kind === "string" || entry.kind === "text"))
    const src = text("src")
    if (src && text("alt")) field.image = { alt: "alt", src: src.name }
  }
  if (kind === "list") field.item = describeField(name, property.items, true, "Item")
  return field
}

/** Describes the form fields of an object JSON Schema, in property order. Unknown shapes become JSON fields. */
export function describeConsoleSchemaFields(schema: Record<string, unknown>): ConsoleSchemaField[] {
  const properties = record(schema.properties) ?? {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(name => String(name) === name) : [])
  return Object.entries(properties).map(([name, value]) => describeField(name, value, required.has(name)))
}

/** The value of a new list item: the defaults of an object, or an empty value of the item's kind. */
export function consoleSchemaItemValue(item: ConsoleSchemaField): unknown {
  if (item.schema.default !== undefined) return JSON.parse(JSON.stringify(item.schema.default))
  if (item.kind === "object") return consoleSchemaDefaults(item.schema)
  if (item.kind === "list" || item.kind === "string-list") return []
  if (item.kind === "boolean") return false
  if (item.kind === "enum") return item.enum?.[0]
  if (item.kind === "number" || item.kind === "integer") return item.minimum ?? 0
  if (item.kind === "string" || item.kind === "text" || item.kind === "date" || item.kind === "date-time") return ""
  return undefined
}

// Names that usually hold the title of a list item, in order of preference.
const itemTitleNames = ["label", "title", "name", "heading", "question", "value"]

/**
 * The title and detail of a list item, such as `Product` and `/product` for a link `{ label, to }`. The title is the
 * first filled field named like a title, else the first filled text field. The detail is the next filled text field,
 * else the size of the first filled list, such as `Links 2`. Other values use their one-line summary.
 */
export function consoleItemTitle(item: ConsoleSchemaField, value: unknown): { detail?: string, title: string } {
  const object = record(value)
  if (item.kind !== "object" || !item.fields || !object) return { title: consoleValueSummary(item.kind === "boolean" ? undefined : item, value) }
  const texts = item.fields
    .filter(field => field.kind === "string" || field.kind === "text" || field.kind === "enum" || field.kind === "date" || field.kind === "date-time")
    .map(field => ({ name: field.name, text: consoleValueSummary(field, object[field.name]) }))
    .filter(entry => entry.text)
  const preferred = itemTitleNames.map(name => texts.find(entry => entry.name === name)).find(entry => entry !== undefined)
  const title = preferred ?? texts[0]
  const detail = texts.find(entry => entry !== title)
  const result: { detail?: string, title: string } = { title: title?.text ?? consoleValueSummary(item, value) }
  const lists = item.fields.flatMap((field) => {
    const entry = object[field.name]
    return (field.kind === "list" || field.kind === "string-list") && Array.isArray(entry) && entry.length ? [`${field.label} ${entry.length}`] : []
  })
  if (detail) result.detail = detail.text
  else if (lists[0]) result.detail = lists[0]
  return result
}

/**
 * The filled children of an object value as label and text pairs, so a folded object reads `Label Book a demo To /demo`.
 * A list counts its items, a switch that is on shows only its label, and a nested object shows its own summary.
 */
export function consoleValueParts(field: Pick<ConsoleSchemaField, "fields">, value: unknown): Array<{ label: string, text: string }> {
  const object = record(value)
  if (!object || !field.fields) return []
  return field.fields.flatMap((child) => {
    const entry = object[child.name]
    if (child.kind === "list" || child.kind === "json") {
      if (!Array.isArray(entry) || !entry.length) return []
      return [{ label: child.label, text: entry.length === 1 ? "1 item" : `${entry.length} items` }]
    }
    if (child.kind === "boolean") return entry === true ? [{ label: child.label, text: "" }] : []
    const text = consoleValueSummary(child, entry)
    return text ? [{ label: child.label, text }] : []
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
    if (field.kind === "list" && field.item?.kind === "object" && field.item.fields && Array.isArray(value)) {
      // Each item drops its own empty optional values, such as a link without an icon.
      const item = field.item
      result[field.name] = value.map(entry => record(entry) ? compactConsoleFieldValues(item.fields!, record(entry)!) : entry)
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
  if (field.kind === "object" || field.kind === "blob" || field.kind === "json" || field.kind === "list") return undefined
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
