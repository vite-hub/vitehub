import { isStandardSchema, standardIssuePath, standardJsonSchema, standardJsonSchemaDateOptions } from "@vite-hub/internal/standard-schema"
import { ViteHubError } from "@vite-hub/runtime"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import type { JsonSchema } from "comark-content"

/** One frontmatter field: any Standard Schema validator, such as Zod, Valibot, ArkType, or a ViteHub Blob `image()`. */
export type ContentField = StandardSchemaV1

/** Frontmatter fields keyed by name. Each value validates one field, so validators from different libraries mix. */
export type ContentFields = Record<string, ContentField>

type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type WithOptionalKeys<T> = Simplify<{ [K in Exclude<keyof T, OptionalKeys<T>>]: T[K] } & { [K in OptionalKeys<T>]?: T[K] }>

/** Validated frontmatter: each field's output type. Fields whose output includes `undefined` are optional keys. */
export type ContentFieldsOutput<TFields extends ContentFields> = WithOptionalKeys<{
  [K in keyof TFields]: StandardSchemaV1.InferOutput<TFields[K]>
}>

/** Frontmatter accepted by `save()`: each field's input type. Fields whose input includes `undefined` are optional keys. */
export type ContentFieldsInput<TFields extends ContentFields> = WithOptionalKeys<{
  [K in keyof TFields]: StandardSchemaV1.InferInput<TFields[K]>
}>

export interface DocumentsOptions<TFields extends ContentFields> {
  /**
   * Workspace glob for the collection's Markdown files, such as `posts/**\/*.md`. The part before the first wildcard is
   * the collection folder; a document id is the path below it without the extension (`posts/2026/hello.md` → `2026/hello`).
   */
  path: string
  /** Frontmatter fields. The Markdown body is always the document `body`. */
  fields: TFields
  /**
   * Field names that `list({ search })` matches as a case-insensitive substring. Defaults to every string field plus
   * the Markdown body.
   */
  search?: ReadonlyArray<keyof TFields & string | "body" | "id">
}

const documentsDefinition: unique symbol = Symbol.for("vitehub.content.documents")

/** A document collection definition created by `documents()`. */
export interface DocumentsDefinition<TFields extends ContentFields = ContentFields> {
  readonly [documentsDefinition]: true
  readonly path: string
  readonly fields: TFields
  readonly search?: ReadonlyArray<string>
}

/**
 * Define an editable collection of Markdown documents with validated frontmatter.
 *
 * @example
 * documents({
 *   path: 'posts/**\/*.md',
 *   fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
 * })
 */
export function documents<const TFields extends ContentFields>(options: DocumentsOptions<TFields>): DocumentsDefinition<TFields> {
  if (Object(options) !== options) throw invalidDefinition("documents() requires { path, fields }.")
  if (String(options.path) !== options.path || !options.path) throw invalidDefinition("documents() requires a path glob such as 'posts/**/*.md'.")
  compileDocumentsPath(options.path)
  if (Object(options.fields) !== options.fields || Array.isArray(options.fields)) {
    throw invalidDefinition(`documents(${JSON.stringify(options.path)}) requires fields: a record of Standard Schema validators.`)
  }
  for (const [name, field] of Object.entries(options.fields)) {
    if (!isStandardSchema(field)) {
      throw invalidDefinition(`documents(${JSON.stringify(options.path)}) field ${JSON.stringify(name)} must be a Standard Schema validator, such as z.string().`)
    }
  }
  if (options.search !== undefined && (!Array.isArray(options.search) || options.search.some(field => String(field) !== field))) {
    throw invalidDefinition(`documents(${JSON.stringify(options.path)}) search must be a list of field names.`)
  }
  const definition: { -readonly [K in keyof DocumentsDefinition<TFields>]: DocumentsDefinition<TFields>[K] } = {
    [documentsDefinition]: true,
    fields: options.fields,
    path: options.path,
  }
  if (options.search) definition.search = [...options.search]
  return definition
}

export function isDocumentsDefinition(value: unknown): value is DocumentsDefinition {
  return value !== null && Object(value) === value && Reflect.get(Object(value), documentsDefinition) === true
}

/**
 * Accept `undefined` for a validator that has no `.optional()`, such as a Blob `image()`.
 *
 * @example
 * fields: { cover: optional(image()) }
 */
export function optional<TSchema extends StandardSchemaV1>(
  schema: TSchema,
): StandardSchemaV1<StandardSchemaV1.InferInput<TSchema> | undefined, StandardSchemaV1.InferOutput<TSchema> | undefined> & StandardJSONSchemaV1 {
  if (!isStandardSchema(schema)) throw invalidDefinition("optional() requires a Standard Schema validator.")
  const inner = schema["~standard"]
  const project = (direction: "input" | "output") => (options: StandardJSONSchemaV1.Options) => standardJsonSchema(schema, direction, options.target, options.libraryOptions) ?? {}
  return {
    "~standard": {
      version: 1,
      vendor: inner.vendor,
      validate: value => value === undefined ? { value: undefined } : inner.validate(value),
      jsonSchema: { input: project("input"), output: project("output") },
    },
  }
}

function invalidDefinition(message: string) {
  return contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] ${message}` })
}

// Paths

export interface CompiledDocumentsPath {
  /** Folder before the first wildcard, with a trailing slash, or "" for the Workspace root. */
  base: string
  /** File extension including the dot, such as `.md`. */
  extension: string
  match(path: string): boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

/** Compile a collection glob. Supports `*`, `**`, and `?`; the last segment must end with `*.<extension>`. */
export function compileDocumentsPath(glob: string): CompiledDocumentsPath {
  const normalized = glob.replace(/^\.?\/+/, "")
  if (/[{}[\]!()]/.test(normalized) || normalized.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw invalidDefinition(`documents() path ${JSON.stringify(glob)} must be a relative glob using only *, **, and ?, such as 'posts/**/*.md'.`)
  }
  const extension = /\*(\.[\w-]+)$/.exec(normalized)?.[1]
  if (!extension) throw invalidDefinition(`documents() path ${JSON.stringify(glob)} must end with one extension, such as 'posts/**/*.md'.`)
  const segments = normalized.split("/")
  const firstWildcard = segments.findIndex(segment => /[*?]/.test(segment))
  const base = segments.slice(0, firstWildcard).map(segment => `${segment}/`).join("")
  let pattern = ""
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!
    if (char === "*" && normalized[index + 1] === "*") {
      const slash = normalized[index + 2] === "/"
      pattern += slash ? "(?:[^/]+/)*" : ".*"
      index += slash ? 2 : 1
    }
    else if (char === "*") pattern += "[^/]*"
    else if (char === "?") pattern += "[^/]"
    else pattern += escapeRegExp(char)
  }
  const regex = new RegExp(`^${pattern}$`)
  return { base, extension, match: path => regex.test(path) }
}

// Fields

export type ContentFieldIssue = {
  /** Field name, or undefined for frontmatter that is not a YAML object. */
  field?: string
  /** Path inside the field value, such as `[0]` for the first tag. */
  path: Array<string | number>
  message: string
}

export type FieldValidation =
  | { data: Record<string, unknown>, issues?: undefined }
  | { data?: undefined, issues: ContentFieldIssue[] }

/** Validate frontmatter field by field. Keys without a field pass through to the file and are left out of `data`. */
export async function validateFields(fields: ContentFields, frontmatter: Record<string, unknown>): Promise<FieldValidation> {
  const data: Record<string, unknown> = {}
  const issues: ContentFieldIssue[] = []
  await Promise.all(Object.entries(fields).map(async ([name, field]) => {
    const value = Object.hasOwn(frontmatter, name) ? frontmatter[name] : undefined
    const result = await field["~standard"].validate(value)
    if (result.issues) {
      for (const issue of result.issues) issues.push({ field: name, message: issue.message, path: standardIssuePath(issue) })
      return
    }
    if (result.value !== undefined) data[name] = result.value
  }))
  if (issues.length) {
    const order = Object.keys(fields)
    issues.sort((left, right) => order.indexOf(left.field!) - order.indexOf(right.field!))
    return { issues }
  }
  return { data }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || Object(value) !== value || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

/**
 * Normalize saved frontmatter to what a reader will parse back: JSON values, with Dates and other `toJSON()` values
 * converted. Validation runs on the normalized value, so a stored file always validates.
 */
export function normalizeFrontmatter(data: unknown): Record<string, unknown> {
  if (data === undefined) return {}
  if (!isPlainRecord(data)) throw new TypeError("data must be a plain object of field values.")
  let normalized: unknown
  try {
    normalized = JSON.parse(JSON.stringify(data))
  }
  catch (cause) {
    throw new TypeError(`data must be JSON-serializable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!isPlainRecord(normalized)) throw new TypeError("data must be a plain object of field values.")
  return normalized
}

/**
 * JSON Schema for the frontmatter, for forms and tools. A Zod `Date` field, such as `z.coerce.date()`, becomes a
 * `date-time` string. Fields without a Standard JSON Schema, such as plain Valibot schemas, become `{}`.
 */
export function fieldsJsonSchema(fields: ContentFields): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, field] of Object.entries(fields)) {
    // Dates are stored as ISO strings, so a date field projects to a date-time string that forms can edit.
    const schema = standardJsonSchema(field, "input", "draft-2020-12", standardJsonSchemaDateOptions) ?? {}
    delete schema.$schema
    properties[name] = schema
    if (!acceptsUndefined(field)) required.push(name)
  }
  return required.length ? { type: "object", properties, required } : { type: "object", properties }
}

const annotationKeywords: ReadonlySet<string> = new Set(["$schema", "default", "deprecated", "description", "examples", "readOnly", "title", "writeOnly"])
const warnedUntypedFields = new Set<string>()

/** Fields whose JSON Schema has no type information, only annotations such as `default`. */
export function untypedFields(schema: Record<string, unknown>): string[] {
  const properties: unknown = schema.properties
  if (!isPlainRecord(properties)) return []
  return Object.entries(properties)
    .filter(([, value]) => !isPlainRecord(value) || Object.keys(value).every(key => annotationKeywords.has(key)))
    .map(([name]) => name)
}

/**
 * Warn once per process for each collection field whose JSON Schema is empty, because forms and tools then get no
 * hint for it. Valibot schemas are the usual cause: they need `toStandardJsonSchema()` from `@valibot/to-json-schema`.
 */
export function warnUntypedFields(collection: string, fields: ContentFields, schema: Record<string, unknown>): void {
  for (const field of untypedFields(schema)) {
    const key = `${collection}\0${field}`
    if (warnedUntypedFields.has(key)) continue
    warnedUntypedFields.add(key)
    const fix = fields[field]?.["~standard"].vendor === "valibot"
      ? "Wrap the Valibot schema in toStandardJsonSchema() from @valibot/to-json-schema"
      : "Use a validator that has a Standard JSON Schema"
    console.warn(
      `[vitehub] Content collection ${JSON.stringify(collection)} field ${JSON.stringify(field)} has no JSON Schema, so forms and tools get no hint for it. `
      + `${fix}. See https://vitehub.dev/docs/content/configure#json-schema`,
    )
  }
}

// A field is optional when its validator accepts a missing value. Async validators count as required.
function acceptsUndefined(field: ContentField): boolean {
  try {
    const result = field["~standard"].validate(undefined)
    return !(result instanceof Promise) && !result.issues
  }
  catch {
    return false
  }
}

/** Narrow a JSON Schema to the subset Comark Content reads: type, properties, required, items, and `x-content`. */
export function comarkJsonSchema(schema: unknown): JsonSchema {
  if (!isPlainRecord(schema)) return {}
  const result: JsonSchema = {}
  const type = schema.type
  if (String(type) === type || (Array.isArray(type) && type.every(entry => String(entry) === entry))) result.type = type
  if (isPlainRecord(schema.properties)) {
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, comarkJsonSchema(value)]))
  }
  if (Array.isArray(schema.required) && schema.required.every(entry => String(entry) === entry)) result.required = [...schema.required]
  if (isPlainRecord(schema.items)) result.items = comarkJsonSchema(schema.items)
  const meta = schema["x-content"]
  if (isPlainRecord(meta)) {
    // SAFETY: x-content is Comark's own field metadata extension; Comark interprets and validates it.
    result["x-content"] = meta as JsonSchema["x-content"]
  }
  return result
}

// Markdown files

export interface ParsedDocumentFile {
  frontmatter: Record<string, unknown>
  body: string
}

/** Split a Markdown file into YAML frontmatter and body. */
export function parseDocumentFile(text: string): ParsedDocumentFile | { issues: ContentFieldIssue[] } {
  const source = text.startsWith("﻿") ? text.slice(1) : text
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return { frontmatter: {}, body: source }
  let parsed: unknown
  try {
    parsed = match[1]?.trim() ? parseYaml(match[1]) : {}
  }
  catch (cause) {
    return { issues: [{ message: `Frontmatter is not valid YAML: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`, path: [] }] }
  }
  if (parsed === null || parsed === undefined) parsed = {}
  if (!isPlainRecord(parsed)) return { issues: [{ message: "Frontmatter must be a YAML mapping of field names to values.", path: [] }] }
  return { frontmatter: parsed, body: source.slice(match[0].length).replace(/^\r?\n/, "") }
}

/** Serialize frontmatter and body. Without fields, the file is the body alone. */
export function renderDocumentFile(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter).length
  // A body that starts with a delimiter needs an empty frontmatter block so it is not read back as frontmatter.
  if (!keys && !/^(?:﻿)?---/.test(body)) return body
  return `---\n${keys ? stringifyYaml(frontmatter) : ""}---\n${body ? `\n${body}` : ""}`
}

/** A readable `CONTENT_INVALID` error listing every field issue. */
export function contentInvalid(collection: string, id: string, path: string, issues: ContentFieldIssue[]): ViteHubError {
  const lines = issues.map((issue) => {
    const where = [issue.field, ...issue.path].filter(segment => segment !== undefined).join(".")
    return `- ${where ? `${where}: ` : ""}${issue.message}`
  })
  return new ViteHubError("CONTENT_INVALID", `[vitehub] Content document ${JSON.stringify(`${collection}/${id}`)} is invalid:\n${lines.join("\n")}`, {
    details: { collection, id, path, issues },
  })
}
