import { ConsoleRequestError, requestConsole } from "./request"
import { dayLabel } from "./time"

import type { ConsoleDocumentCollection } from "../definitions"

// These types mirror the document editor contract in `@vite-hub/internal/console`.

export type ConsoleDocumentState = "draft" | "published" | "changed" | "deleted"

export const consoleDocumentStates: readonly ConsoleDocumentState[] = ["draft", "changed", "published", "deleted"]

export interface ConsoleDocumentSummary {
  data: Record<string, unknown>
  /** Draft digest, or null for a document deleted on the draft. */
  digest: string | null
  id: string
  path: string
  state: ConsoleDocumentState
  title: string
  updatedAt: string | null
}

/** A document to publish and the draft digest the user reviewed. */
export interface ConsoleDocumentPublishExpectation {
  digest: string | null
  id: string
}

export interface ConsoleDocumentChange extends ConsoleDocumentPublishExpectation {
  state: Exclude<ConsoleDocumentState, "published">
}

export interface ConsoleDocumentPage {
  /** Every unpublished change of the collection, before search, state, and filters. */
  changes: ConsoleDocumentChange[]
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
  updatedAt: string | null
}

/** One stored file as written, frontmatter included. */
export interface ConsoleRawDocument {
  collection: string
  digest: string
  id: string
  path: string
  revision: string
  text: string
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

/** One unpublished change with its title, for the dashboard. */
export interface ConsoleDocumentPendingChange extends ConsoleDocumentChange {
  title: string
  updatedAt: string | null
}

export interface ConsoleDocumentOverviewCollection {
  /** Every unpublished change, most recently changed first. */
  changes: ConsoleDocumentPendingChange[]
  name: string
  states: Record<ConsoleDocumentState, number>
}

/** One recent revision that changed documents. */
export interface ConsoleDocumentActivity {
  action: string
  author?: string
  createdAt: string
  documents: Array<{ collection: string, id: string, title: string }>
  id: string
  ref: string
}

/** Counts, unpublished changes, and recent activity of every readable collection. */
export interface ConsoleDocumentOverview {
  activity: ConsoleDocumentActivity[]
  collections: ConsoleDocumentOverviewCollection[]
}

export interface ConsoleDocumentSearchResult {
  collection: string
  id: string
  state: ConsoleDocumentState
  title: string
  updatedAt: string | null
}

/** The result of each owner document action. */
interface ConsoleDocumentActionResults {
  get: ConsoleDocument | null
  list: ConsoleDocumentPage
  overview: ConsoleDocumentOverview
  search: { items: ConsoleDocumentSearchResult[] }
  publish: ConsoleDocumentPublished
  raw: ConsoleRawDocument | null
  remove: null
  restore: ConsoleDocument
  revisions: { cursor?: string, revisions: ConsoleDocumentRevision[] }
  save: ConsoleDocument
}

/** The owner document actions of one document editor section, called through the Console RPC transport. */
export interface ConsoleDocumentsClient {
  get(collection: string, id: string): Promise<ConsoleDocument | null>
  list(collection: string, query?: ConsoleDocumentListQuery): Promise<ConsoleDocumentPage>
  /** Counts, unpublished changes, and recent activity of every readable collection, in one request. */
  overview(options?: { activity?: number }): Promise<ConsoleDocumentOverview>
  /** Finds drafts by title, id, fields, and body across every readable collection. */
  search(query: string, options?: { limit?: number, signal?: AbortSignal }): Promise<ConsoleDocumentSearchResult[]>
  /** Publishes exactly these drafts. A draft saved after review fails with a conflict and nothing is published. */
  publish(collection: string, expect: readonly ConsoleDocumentPublishExpectation[]): Promise<ConsoleDocumentPublished>
  /** Reads the stored file on the draft, or at an earlier revision, without validating it. */
  raw(collection: string, id: string, revision?: string): Promise<ConsoleRawDocument | null>
  remove(collection: string, id: string, ifDigest: string): Promise<null>
  restore(collection: string, id: string, revision: string, ifDigest: string | null): Promise<ConsoleDocument>
  revisions(collection: string, id: string, cursor?: string): Promise<{ cursor?: string, revisions: ConsoleDocumentRevision[] }>
  save(collection: string, id: string, input: { body: string, data: Record<string, unknown>, ifDigest: string | null }): Promise<ConsoleDocument>
}

/** Calls the owner document actions of one document editor section. */
export function createConsoleDocumentsClient(base: string, section: string): ConsoleDocumentsClient {
  async function call<TAction extends keyof ConsoleDocumentActionResults>(action: TAction, body: Record<string, unknown>, signal?: AbortSignal): Promise<ConsoleDocumentActionResults[TAction]> {
    const options: Parameters<typeof requestConsole>[1] = { body, method: "POST", query: { action, section } }
    if (signal) options.signal = signal
    const value = await requestConsole(base, options)
    // SAFETY: The owner actions return the mirrored contract for this action. The editor renders fields as text and checks ids before use.
    return value as ConsoleDocumentActionResults[TAction]
  }
  return {
    list: (collection: string, query: ConsoleDocumentListQuery = {}) => call("list", { collection, ...query }),
    overview: (options: { activity?: number } = {}) => call("overview", { ...options }),
    search: async (query: string, options: { limit?: number, signal?: AbortSignal } = {}) =>
      (await call("search", options.limit ? { limit: options.limit, query } : { query }, options.signal)).items,
    get: (collection: string, id: string) => call("get", { collection, id }),
    raw: (collection: string, id: string, revision?: string) => call("raw", revision ? { collection, id, revision } : { collection, id }),
    save: (collection: string, id: string, input: { body: string, data: Record<string, unknown>, ifDigest: string | null }) =>
      call("save", { collection, id, ...input }),
    remove: (collection: string, id: string, ifDigest: string) => call("remove", { collection, id, ifDigest }),
    publish: (collection: string, expect: readonly ConsoleDocumentPublishExpectation[]) =>
      call("publish", { collection, expect: expect.map(({ digest, id }) => ({ digest, id })) }),
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

/** The document a `CONTENT_INVALID` failure names, as `publish` reports a draft that no longer validates. */
export function consoleInvalidDocument(error: unknown): string | undefined {
  if (!(error instanceof ConsoleRequestError) || error.failureCode !== "CONTENT_INVALID") return
  const id = error.details?.id
  return String(id) === id ? id : undefined
}

export function isConsoleConflict(error: unknown): boolean {
  return error instanceof ConsoleRequestError && error.failureCode === "WORKSPACE_CONFLICT"
}

/** A draft that moved after review, as a publish conflict reports it. `actual` is null when the draft deleted it. */
export interface ConsolePublishMismatch {
  actual: string | null
  expected: string | null
  id: string
}

/** Returns the documents that changed after review, from a publish conflict, or undefined for another error. */
export function consolePublishMismatches(error: unknown): ConsolePublishMismatch[] | undefined {
  if (!isConsoleConflict(error) || !(error instanceof ConsoleRequestError)) return
  const documents = error.details?.documents
  if (!Array.isArray(documents)) return
  return documents.flatMap((entry) => {
    if (!(entry instanceof Object) || Array.isArray(entry)) return []
    const id: unknown = Reflect.get(entry, "id")
    const expected: unknown = Reflect.get(entry, "expected")
    const actual: unknown = Reflect.get(entry, "actual")
    if (String(id) !== id) return []
    return [{ actual: String(actual) === actual ? actual : null, expected: String(expected) === expected ? expected : null, id }]
  })
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

/**
 * `Posts` → `Post` and `Stories` → `Story`, for toasts such as `Post deleted`. Labels that are not a plain one-word plural
 * become `Document`.
 */
export function consoleSingularLabel(label: string): string {
  const word = label.trim()
  if (/\s/.test(word) || !/s$/i.test(word) || /(ss|us|is|news|series)$/i.test(word)) return "Document"
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`
  return word.slice(0, -1)
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

// List view state in the URL: `?q=launch&state=draft&sort=date:desc&filter.category=story`.

export type ConsoleListState = ConsoleDocumentState | "all"

export interface ConsoleListView {
  filters: Record<string, string>
  search: string
  sort: string
  state: ConsoleListState
}

const filterPrefix = "filter."

function queryText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return String(first) === first && first ? first : undefined
}

/** Reads the list view from a route query. Unknown states, sorts, and filter fields fall back to the defaults. */
export function parseConsoleListQuery(
  query: Readonly<Record<string, unknown>>,
  options: { facets: readonly string[], sorts: readonly string[] },
): ConsoleListView {
  const state = queryText(query.state)
  const sort = queryText(query.sort)
  const filters: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    const name = key.startsWith(filterPrefix) ? key.slice(filterPrefix.length) : undefined
    const text = queryText(value)
    if (name && text && options.facets.includes(name)) filters[name] = text
  }
  return {
    filters,
    search: queryText(query.q) ?? "",
    sort: sort && options.sorts.includes(sort) ? sort : options.sorts[0] ?? "id:asc",
    state: consoleDocumentStates.find(entry => entry === state) ?? "all",
  }
}

/** Writes the list view as a route query, leaving out defaults so a fresh list has a clean URL. */
export function consoleListQuery(view: ConsoleListView, defaultSort: string): Record<string, string> {
  const query: Record<string, string> = {}
  if (view.search.trim()) query.q = view.search.trim()
  if (view.state !== "all") query.state = view.state
  if (view.sort !== defaultSort) query.sort = view.sort
  for (const [name, value] of Object.entries(view.filters).sort(([left], [right]) => left.localeCompare(right))) {
    if (value) query[`${filterPrefix}${name}`] = value
  }
  return query
}

// Frontmatter for comparisons: YAML-style lines, so nested fields diff line by line instead of as one JSON line.

function frontmatterScalar(value: unknown): string {
  if (String(value) !== value) return JSON.stringify(value)
  // Plain text stays unquoted unless YAML would read it as another type or as syntax.
  const plain = /^[\p{L}\p{N}][^:#\n]*$/u.test(value) && !/^(true|false|null|yes|no|~|[-+]?\d[\d._e+-]*)$/i.test(value) && value.trim() === value
  return plain ? value : JSON.stringify(value)
}

function frontmatterLines(key: string, value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}${key}: []`]
    if (value.every(entry => !(entry instanceof Object))) return [`${indent}${key}: [${value.map(frontmatterScalar).join(", ")}]`]
    return [`${indent}${key}:`, ...value.map(entry => `${indent}  - ${entry instanceof Object ? JSON.stringify(entry) : frontmatterScalar(entry)}`)]
  }
  const object = record(value)
  if (object) {
    const entries = Object.entries(object).sort(([left], [right]) => left.localeCompare(right))
    if (!entries.length) return [`${indent}${key}: {}`]
    return [`${indent}${key}:`, ...entries.flatMap(([child, entry]) => frontmatterLines(child, entry, `${indent}  `))]
  }
  return [`${indent}${key}: ${frontmatterScalar(value)}`]
}

/** Renders document fields as sorted YAML-style frontmatter lines, for the comparison view. */
export function renderConsoleFrontmatter(data: Record<string, unknown>): string {
  return Object.entries(data)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => frontmatterLines(key, value, ""))
    .join("\n")
}

// The list keeps its view when someone opens a document and comes back.
const listQueries = new Map<string, Record<string, string>>()

/** Remembers the list query of a collection, so Back from the editor returns to the same tab, sort, and filters. */
export function rememberConsoleListQuery(collection: string, query: Record<string, string>): void {
  listQueries.set(collection, { ...query })
}

/** The last list query of a collection, or an empty query. */
export function consoleListQueryFor(collection: string): Record<string, string> {
  return { ...listQueries.get(collection) }
}

/** Groups revisions, newest first, under day labels such as `Today` and `Oct 12`. */
export function groupConsoleRevisions(revisions: readonly ConsoleDocumentRevision[], now: number, timeZone?: string): Array<{ label: string, revisions: ConsoleDocumentRevision[] }> {
  const groups: Array<{ label: string, revisions: ConsoleDocumentRevision[] }> = []
  for (const revision of revisions) {
    const label = dayLabel(revision.createdAt, now, timeZone) ?? "Unknown date"
    const last = groups.at(-1)
    if (last?.label === label) last.revisions.push(revision)
    else groups.push({ label, revisions: [revision] })
  }
  return groups
}

/** What a revision did, as History names it: `Saved`, `Published`, `Restored`, `Deleted`, or `Started draft`. */
export function consoleRevisionLabel(revision: ConsoleDocumentRevision): string {
  if (revision.ref === "published" || revision.action === "publish") return "Published"
  return new Map([["remove", "Deleted"], ["restore", "Restored"], ["save", "Saved"], ["seed", "Started draft"]]).get(revision.action) ?? "Changed"
}

export function consoleRevisionTone(revision: ConsoleDocumentRevision): "error" | "neutral" | "success" {
  if (revision.ref === "published" || revision.action === "publish") return "success"
  return revision.action === "remove" ? "error" : "neutral"
}

/** Consecutive saves by one author, newest first. `revisions[0]` is the latest save of the run. */
export interface ConsoleRevisionRun {
  revisions: ConsoleDocumentRevision[]
}

/** Saves further apart than this start a new run, even from the same author. */
const revisionRunGap = 15 * 60_000

/**
 * Collapses consecutive saves by the same author into runs for History. The editor saves a draft after each pause in
 * typing, so one sitting writes many revisions; History shows them as one row. Publishes, restores, deletes, saves by
 * someone else, and saves more than 15 minutes apart each start a new run. Storage keeps every revision.
 */
export function groupConsoleRevisionRuns(revisions: readonly ConsoleDocumentRevision[]): ConsoleRevisionRun[] {
  const runs: ConsoleRevisionRun[] = []
  for (const revision of revisions) {
    const last = runs.at(-1)?.revisions.at(-1)
    const joins = last && revision.action === "save" && last.action === "save" && revision.ref === last.ref && revision.author === last.author
      && Math.abs(Date.parse(last.createdAt) - Date.parse(revision.createdAt)) <= revisionRunGap
    if (joins) runs.at(-1)!.revisions.push(revision)
    else runs.push({ revisions: [revision] })
  }
  return runs
}

export type { ConsoleDocumentCollection }
