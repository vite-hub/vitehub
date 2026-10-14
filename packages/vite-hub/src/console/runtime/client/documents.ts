import { ConsoleRequestError, requestConsole } from "./request"

import type { ConsoleDocumentCollection } from "../definitions"

// These types mirror the document editor contract in `@vite-hub/internal/console`.

export type ConsoleDocumentState = "draft" | "published" | "changed" | "deleted"

export const consoleDocumentStates: readonly ConsoleDocumentState[] = ["draft", "changed", "published", "deleted"]

export interface ConsoleDocumentSummary {
  data: Record<string, unknown>
  id: string
  path: string
  state: ConsoleDocumentState
  title: string
}

export interface ConsoleDocumentPage {
  facets?: Record<string, Array<{ count: number, value: string }>>
  items: ConsoleDocumentSummary[]
  nextCursor: string | null
  states: Record<ConsoleDocumentState, number>
  total: number
}

export interface ConsoleDocument {
  body: string
  collection: string
  data: Record<string, unknown>
  digest: string
  id: string
  path: string
  revision: string
  state?: ConsoleDocumentState
}

export interface ConsoleDocumentRevision {
  action: string
  author?: string
  createdAt: string
  id: string
  message?: string
  ref: string
}

export interface ConsoleDocumentListQuery {
  cursor?: string
  facets?: readonly string[]
  filter?: Record<string, string | readonly string[]>
  limit?: number
  search?: string
  sort?: { direction?: "asc" | "desc", field: string }
  state?: ConsoleDocumentState
}

/** One invalid field value, as `CONTENT_INVALID` reports it. */
export interface ConsoleFieldIssue {
  field?: string
  message: string
  path: Array<string | number>
}

export interface ConsoleDocumentPublished {
  documents: Array<{ change: "add" | "update" | "delete", collection: string, id: string }>
  revision: string | null
}

/** The result of each owner document action. */
interface ConsoleDocumentActionResults {
  get: ConsoleDocument | null
  list: ConsoleDocumentPage
  publish: ConsoleDocumentPublished
  remove: null
  restore: ConsoleDocument
  revisions: { cursor?: string, revisions: ConsoleDocumentRevision[] }
  save: ConsoleDocument
}

/** The owner document actions of one document editor section, called through the Console RPC transport. */
export interface ConsoleDocumentsClient {
  get(collection: string, id: string, revision?: string): Promise<ConsoleDocument | null>
  list(collection: string, query?: ConsoleDocumentListQuery): Promise<ConsoleDocumentPage>
  publish(collection: string, ids?: readonly string[]): Promise<ConsoleDocumentPublished>
  remove(collection: string, id: string, ifDigest: string): Promise<null>
  restore(collection: string, id: string, revision: string, ifDigest: string | null): Promise<ConsoleDocument>
  revisions(collection: string, id: string, cursor?: string): Promise<{ cursor?: string, revisions: ConsoleDocumentRevision[] }>
  save(collection: string, id: string, input: { body: string, data: Record<string, unknown>, ifDigest: string | null }): Promise<ConsoleDocument>
}

/** Calls the owner document actions of one document editor section. */
export function createConsoleDocumentsClient(base: string, section: string): ConsoleDocumentsClient {
  async function call<TAction extends keyof ConsoleDocumentActionResults>(action: TAction, body: Record<string, unknown>): Promise<ConsoleDocumentActionResults[TAction]> {
    const value = await requestConsole(base, { body, method: "POST", query: { action, section } })
    // SAFETY: The owner actions return the mirrored contract for this action. The editor renders fields as text and checks ids before use.
    return value as ConsoleDocumentActionResults[TAction]
  }
  return {
    list: (collection: string, query: ConsoleDocumentListQuery = {}) => call("list", { collection, ...query }),
    get: (collection: string, id: string, revision?: string) => call("get", revision ? { collection, id, revision } : { collection, id }),
    save: (collection: string, id: string, input: { body: string, data: Record<string, unknown>, ifDigest: string | null }) =>
      call("save", { collection, id, ...input }),
    remove: (collection: string, id: string, ifDigest: string) => call("remove", { collection, id, ifDigest }),
    publish: (collection: string, ids?: readonly string[]) => call("publish", ids ? { collection, ids } : { collection }),
    revisions: (collection: string, id: string, cursor?: string) =>
      call("revisions", cursor ? { collection, cursor, id } : { collection, id }),
    restore: (collection: string, id: string, revision: string, ifDigest: string | null) => call("restore", { collection, id, ifDigest, revision }),
  }
}


/** Returns the field issues of a `CONTENT_INVALID` failure, or undefined for another error. */
export function consoleFieldIssues(error: unknown): ConsoleFieldIssue[] | undefined {
  if (!(error instanceof ConsoleRequestError) || error.failureCode !== "CONTENT_INVALID") return
  const issues = error.details?.issues
  if (!Array.isArray(issues)) return []
  return issues.flatMap((issue) => {
    if (!(issue instanceof Object) || Array.isArray(issue)) return []
    const message: unknown = Reflect.get(issue, "message")
    const field: unknown = Reflect.get(issue, "field")
    const path: unknown = Reflect.get(issue, "path")
    if (String(message) !== message) return []
    const entry: ConsoleFieldIssue = { message, path: Array.isArray(path) ? path.filter(segment => String(segment) === segment || Number.isInteger(segment)) : [] }
    if (String(field) === field) entry.field = field
    return [entry]
  })
}

export function isConsoleConflict(error: unknown): boolean {
  return error instanceof ConsoleRequestError && error.failureCode === "WORKSPACE_CONFLICT"
}

export function consoleErrorMessage(error: unknown, fallback = "The request failed."): string {
  return error instanceof Error && error.message ? error.message : fallback
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

// Schema form model

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
    if (items && itemTypes.length === 1 && itemTypes[0] === "string" && !items.enum && !items.format) return "string-list"
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

/** A document id from a title: lowercase words joined by dashes, such as `hello-world`. */
export function consoleDocumentSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/(^|\/)-+|-+(?=\/|$)/g, "$1")
    .replace(/^\/+|\/+$/g, "")
}

/** Whether the server accepts an id: relative path segments without `.` or `..`. */
export function isConsoleDocumentId(id: string): boolean {
  return Boolean(id) && !id.startsWith("/") && !id.endsWith("/") && !id.includes("\\")
    && id.split("/").every(segment => segment && segment !== "." && segment !== "..")
}

export function stableConsoleJSON(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    const object = record(entry)
    return object && !Array.isArray(entry) ? Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right))) : entry
  })
}

export function consoleDocumentStateLabel(state: ConsoleDocumentState): string {
  return { changed: "Changed", deleted: "Deleted", draft: "Draft", published: "Published" }[state]
}

export function consoleDocumentStateColor(state: ConsoleDocumentState): "error" | "neutral" | "success" | "warning" {
  return ({ changed: "warning", deleted: "error", draft: "neutral", published: "success" } as const)[state]
}

export type { ConsoleDocumentCollection }
