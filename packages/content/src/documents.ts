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

/**
 * How a document file is stored, from its extension:
 * - `markdown`: YAML frontmatter fields and a Markdown `body` (`.md` and any other extension).
 * - `json`: one JSON object of fields, no body (`.json`).
 * - `yaml`: one YAML mapping of fields, no body (`.yaml`, `.yml`).
 */
export type ContentFormat = "markdown" | "json" | "yaml"

/**
 * How a document maps to its public URL: a root-relative pattern such as `/blog/:id`, or a function of the document.
 * A pattern replaces `:id` with the document id and `:<field>` with a text or number field. A function, or a pattern
 * whose field has no value, may return null for a document without a page.
 */
export type ContentDocumentUrl<TData = Record<string, unknown>> =
  | string
  | ((document: { id: string, data: TData }) => string | null | undefined)

export interface DocumentsOptions<TFields extends ContentFields> {
  /**
   * Workspace glob for the collection's files, such as `posts/**\/*.md` or `authors/*.json`. The part before the first
   * wildcard is the collection folder; a document id is the path below it without the extension
   * (`posts/2026/hello.md` → `2026/hello`). The extension sets the format: `.json` and `.yaml`/`.yml` store data only.
   */
  path: string
  /** Document fields: frontmatter for Markdown, the whole object for JSON and YAML. A Markdown body is always `body`. */
  fields: TFields
  /**
   * Field names that `list({ search })` matches as a case-insensitive substring. Defaults to every string field plus
   * the Markdown body.
   */
  search?: ReadonlyArray<keyof TFields & string | "body" | "id">
  /**
   * Comark components that bodies may use, keyed by tag, such as `alert` for `::alert`. Editors such as the Console
   * offer them in their insert menu. Content still stores and returns the Markdown as written.
   */
  components?: Record<string, DocumentComponent>
  /**
   * The public URL of each document, such as `/blog/:id`. Reads expose it as `document.url`; canonical links, sitemaps,
   * and previews use it. Omit it for documents without their own page.
   */
  url?: ContentDocumentUrl<ContentFieldsOutput<TFields>>
}

/** One Comark component that document bodies may use. */
export interface DocumentComponent {
  /** `block` wraps Markdown between `::alert` and `::`. `inline` sits inside text, as in `:badge[New]`. Defaults to `block`. */
  kind?: "block" | "inline"
  /** Name in insert menus. Defaults to the tag in sentence case, such as `Alert`. */
  label?: string
  /** One line that says what the component shows. */
  description?: string
  /** Props and how each round-trips through Comark attributes. `default` is what a new component starts with. */
  props?: Record<string, DocumentComponentProp>
}

/** How a component prop round-trips: strings as written (`type="info"`), other types with Comark's `:` prefix. */
export interface DocumentComponentProp {
  type: "string" | "number" | "boolean" | "json"
  default?: unknown
}

export interface SingletonOptions<TFields extends ContentFields> {
  /**
   * Workspace path of the one file, such as `settings.json`, `site.yaml`, or `pages/home.md`. The extension sets the
   * format, and the file name without it is the document id (`settings.json` → `settings`).
   */
  path: string
  /** Document fields: frontmatter for Markdown, the whole object for JSON and YAML. */
  fields: TFields
  /** The public URL of the document, such as `/` or `/about`. Omit it for data without a page, such as settings. */
  url?: ContentDocumentUrl<ContentFieldsOutput<TFields>>
}

const collectionDefinition: unique symbol = Symbol.for("vitehub.content.documents")

interface CollectionDefinitionBase<TFields extends ContentFields> {
  readonly [collectionDefinition]: true
  /** The collection glob, or the file path of a singleton. */
  readonly path: string
  readonly fields: TFields
  readonly format: ContentFormat
  /** How each document maps to its public URL, when it has one. */
  readonly url?: ContentDocumentUrl<any>
}

/** A document collection definition created by `documents()`. */
export interface DocumentsDefinition<TFields extends ContentFields = ContentFields> extends CollectionDefinitionBase<TFields> {
  readonly kind: "documents"
  readonly search?: ReadonlyArray<string>
  readonly components?: Readonly<Record<string, DocumentComponent>>
}

/** A singleton definition created by `singleton()`: one document at a fixed path, such as site settings. */
export interface SingletonDefinition<TFields extends ContentFields = ContentFields> extends CollectionDefinitionBase<TFields> {
  readonly kind: "singleton"
}

/** Any entry of `defineContent({ collections })`. */
export type ContentCollectionDefinition<TFields extends ContentFields = ContentFields> = DocumentsDefinition<TFields> | SingletonDefinition<TFields>

function assertFields(helper: string, path: string, fields: unknown): void {
  if (Object(fields) !== fields || Array.isArray(fields)) {
    throw invalidDefinition(`${helper}(${JSON.stringify(path)}) requires fields: a record of Standard Schema validators.`)
  }
  for (const [name, field] of Object.entries(fields as Record<string, unknown>)) {
    if (!isStandardSchema(field)) {
      throw invalidDefinition(`${helper}(${JSON.stringify(path)}) field ${JSON.stringify(name)} must be a Standard Schema validator, such as z.string().`)
    }
  }
}

/**
 * Define an editable collection of documents with validated fields. Markdown files keep fields in YAML frontmatter
 * above a body; `.json` and `.yaml` files are data only.
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
  if (!/[*?]/.test(options.path)) {
    throw invalidDefinition(`documents() path ${JSON.stringify(options.path)} has no wildcard. Use singleton({ path: ${JSON.stringify(options.path)} }) for one document, or a glob such as 'posts/*.md'.`)
  }
  const compiled = compileDocumentsPath(options.path)
  assertFields("documents", options.path, options.fields)
  if (options.search !== undefined && (!Array.isArray(options.search) || options.search.some(field => String(field) !== field))) {
    throw invalidDefinition(`documents(${JSON.stringify(options.path)}) search must be a list of field names.`)
  }
  assertUrl("documents", options.path, options.url, options.fields)
  const definition: { -readonly [K in keyof DocumentsDefinition<TFields>]: DocumentsDefinition<TFields>[K] } = {
    [collectionDefinition]: true,
    kind: "documents",
    fields: options.fields,
    format: compiled.format,
    path: options.path,
  }
  if (options.search) definition.search = [...options.search]
  if (options.components !== undefined) definition.components = documentComponents(options.path, options.components)
  if (options.url !== undefined) definition.url = options.url
  return definition
}

const componentTag = /^[a-z][a-z0-9-]*$/
const componentPropTypes: ReadonlyArray<DocumentComponentProp["type"]> = ["string", "number", "boolean", "json"]

function isComponentPropType(value: unknown): value is DocumentComponentProp["type"] {
  return componentPropTypes.some(type => type === value)
}

function documentComponents(path: string, components: unknown): Record<string, DocumentComponent> {
  const where = `documents(${JSON.stringify(path)}) components`
  if (Object(components) !== components || Array.isArray(components)) throw invalidDefinition(`${where} must be a record of component definitions keyed by tag, such as { alert: {} }.`)
  const result: Record<string, DocumentComponent> = {}
  for (const [tag, value] of Object.entries(Object(components))) {
    if (!componentTag.test(tag)) throw invalidDefinition(`${where}: ${JSON.stringify(tag)} must be a lowercase Comark tag, such as alert or call-out.`)
    if (Object(value) !== value || Array.isArray(value)) throw invalidDefinition(`${where}.${tag} must be an object, such as { kind: 'block' }.`)
    const kind: unknown = Reflect.get(Object(value), "kind")
    if (kind !== undefined && kind !== "block" && kind !== "inline") throw invalidDefinition(`${where}.${tag}.kind must be 'block' or 'inline'.`)
    const component: DocumentComponent = { kind: kind === "inline" ? "inline" : "block" }
    for (const key of ["label", "description"] as const) {
      const text: unknown = Reflect.get(Object(value), key)
      if (text === undefined) continue
      if (String(text) !== text) throw invalidDefinition(`${where}.${tag}.${key} must be a string.`)
      component[key] = text
    }
    const props: unknown = Reflect.get(Object(value), "props")
    if (props !== undefined) {
      if (Object(props) !== props || Array.isArray(props)) throw invalidDefinition(`${where}.${tag}.props must be a record such as { type: { type: 'string' } }.`)
      component.props = {}
      for (const [name, prop] of Object.entries(Object(props))) {
        const type: unknown = Reflect.get(Object(prop), "type")
        if (!isComponentPropType(type)) throw invalidDefinition(`${where}.${tag}.props.${name}.type must be string, number, boolean, or json.`)
        const entry: DocumentComponentProp = { type }
        const fallback: unknown = Reflect.get(Object(prop), "default")
        if (fallback !== undefined) entry.default = JSON.parse(JSON.stringify(fallback))
        component.props[name] = entry
      }
    }
    result[tag] = component
  }
  return result
}

/**
 * Define a singleton: one editable document at a fixed path, such as site settings. It has the same drafts, publishing,
 * history, and validation as a `documents()` collection, without a list.
 *
 * @example
 * singleton({
 *   path: 'settings.json',
 *   fields: { title: z.string(), description: z.string().optional(), social: z.array(z.url()).default([]) },
 * })
 */
export function singleton<const TFields extends ContentFields>(options: SingletonOptions<TFields>): SingletonDefinition<TFields> {
  if (Object(options) !== options) throw invalidDefinition("singleton() requires { path, fields }.")
  if (String(options.path) !== options.path || !options.path) throw invalidDefinition("singleton() requires a file path such as 'settings.json'.")
  const compiled = compileSingletonPath(options.path)
  assertFields("singleton", options.path, options.fields)
  assertUrl("singleton", options.path, options.url, options.fields)
  const definition: { -readonly [K in keyof SingletonDefinition<TFields>]: SingletonDefinition<TFields>[K] } = {
    [collectionDefinition]: true,
    kind: "singleton",
    fields: options.fields,
    format: compiled.format,
    path: compiled.path,
  }
  if (options.url !== undefined) definition.url = options.url
  return definition
}

const urlToken = /:([A-Za-z_$][\w$]*)/g

function assertUrl(helper: string, path: string, url: unknown, fields: ContentFields): void {
  if (url === undefined || url instanceof Function) return
  if (String(url) !== url || !url.startsWith("/") || url.startsWith("//")) {
    throw invalidDefinition(`${helper}(${JSON.stringify(path)}) url must be a function or a path pattern that starts with /, such as '/blog/:id'.`)
  }
  for (const [, name] of url.matchAll(urlToken)) {
    if (name !== "id" && !Object.hasOwn(fields, name!)) {
      throw invalidDefinition(`${helper}(${JSON.stringify(path)}) url ${JSON.stringify(url)} uses :${name}, which is neither :id nor a field.`)
    }
  }
}

/**
 * Resolve the public URL of a document from its definition, or null when it has none. Pattern values are encoded per
 * path segment, so an id such as `2026/hello` keeps its slash.
 */
export function contentDocumentUrl(url: ContentDocumentUrl<any> | undefined, document: { id: string, data: Record<string, unknown> }): string | null {
  if (url === undefined) return null
  if (url instanceof Function) {
    const result: unknown = url({ id: document.id, data: document.data })
    if (result === null || result === undefined) return null
    if (String(result) !== result || !result.startsWith("/") || result.startsWith("//")) {
      throw invalidDefinition(`Content url() must return a path that starts with /, or null, received ${JSON.stringify(result)} for ${JSON.stringify(document.id)}.`)
    }
    return result
  }
  let missing = false
  const resolved = url.replace(urlToken, (_match, name: string) => {
    const value = name === "id" ? document.id : document.data[name]
    if (String(value) !== value && !Number.isFinite(value)) {
      missing = true
      return ""
    }
    return String(value).split("/").map(encodeURIComponent).join("/")
  })
  return missing ? null : resolved
}

export function isContentCollectionDefinition(value: unknown): value is ContentCollectionDefinition {
  return value !== null && Object(value) === value && Reflect.get(Object(value), collectionDefinition) === true
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
  /** Folder before the first wildcard, or of the single file, with a trailing slash, or "" for the Workspace root. */
  base: string
  /** File extension including the dot, such as `.md`. */
  extension: string
  format: ContentFormat
  match(path: string): boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

/** The format a file extension stores. Extensions other than JSON and YAML are Markdown. */
export function contentFormatOf(extension: string): ContentFormat {
  const lower = extension.toLowerCase()
  if (lower === ".json") return "json"
  if (lower === ".yaml" || lower === ".yml") return "yaml"
  return "markdown"
}

function normalizeDefinitionPath(helper: string, path: string, example: string): string {
  const normalized = path.replace(/^\.?\/+/, "")
  if (/[{}[\]!()]/.test(normalized) || normalized.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw invalidDefinition(`${helper}() path ${JSON.stringify(path)} must be a relative ${helper === "singleton" ? "file path" : "glob using only *, **, and ?"}, such as '${example}'.`)
  }
  return normalized
}

/** Compile a collection glob. Supports `*`, `**`, and `?`; the last segment must end with `*.<extension>`. */
export function compileDocumentsPath(glob: string): CompiledDocumentsPath {
  const normalized = normalizeDefinitionPath("documents", glob, "posts/**/*.md")
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
  return { base, extension, format: contentFormatOf(extension), match: path => regex.test(path) }
}

/** Compile the fixed path of a singleton. Its id is the file name without the extension. */
export function compileSingletonPath(path: string): CompiledDocumentsPath & { path: string, id: string } {
  const normalized = normalizeDefinitionPath("singleton", path, "settings.json")
  if (/[*?]/.test(normalized)) {
    throw invalidDefinition(`singleton() path ${JSON.stringify(path)} must name one file. Use documents({ path: ${JSON.stringify(path)} }) for a collection.`)
  }
  const slash = normalized.lastIndexOf("/")
  const name = normalized.slice(slash + 1)
  const extension = /[^.](\.[\w-]+)$/.exec(name)?.[1]
  if (!extension) throw invalidDefinition(`singleton() path ${JSON.stringify(path)} must end with an extension, such as 'settings.json' or 'pages/home.md'.`)
  return {
    base: normalized.slice(0, slash + 1),
    extension,
    format: contentFormatOf(extension),
    id: name.slice(0, -extension.length),
    match: candidate => candidate === normalized,
    path: normalized,
  }
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

// Files

export interface ParsedDocumentFile {
  frontmatter: Record<string, unknown>
  body: string
}

/** YAML output that diffs line by line: block mappings and lists, and long strings kept on one line. */
const yamlOptions = { lineWidth: 0 } as const

function yamlIssue(cause: unknown, what: string): ContentFieldIssue {
  return { message: `${what} is not valid YAML: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`, path: [] }
}

/**
 * Parse a stored file. Markdown splits YAML frontmatter from the body. JSON and YAML files are one object of fields
 * with an empty body.
 */
export function parseDocumentFile(text: string, format: ContentFormat = "markdown"): ParsedDocumentFile | { issues: ContentFieldIssue[] } {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text
  if (format === "json") {
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    }
    catch (cause) {
      return { issues: [{ message: `The file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, path: [] }] }
    }
    if (!isPlainRecord(parsed)) return { issues: [{ message: "A JSON document must be one object of field names to values.", path: [] }] }
    return { frontmatter: parsed, body: "" }
  }
  if (format === "yaml") {
    let parsed: unknown
    try {
      parsed = source.trim() ? parseYaml(source) : {}
    }
    catch (cause) {
      return { issues: [yamlIssue(cause, "The file")] }
    }
    if (parsed === null || parsed === undefined) parsed = {}
    if (!isPlainRecord(parsed)) return { issues: [{ message: "A YAML document must be one mapping of field names to values.", path: [] }] }
    return { frontmatter: parsed, body: "" }
  }
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return { frontmatter: {}, body: source }
  let parsed: unknown
  try {
    parsed = match[1]?.trim() ? parseYaml(match[1]) : {}
  }
  catch (cause) {
    return { issues: [yamlIssue(cause, "Frontmatter")] }
  }
  if (parsed === null || parsed === undefined) parsed = {}
  if (!isPlainRecord(parsed)) return { issues: [{ message: "Frontmatter must be a YAML mapping of field names to values.", path: [] }] }
  return { frontmatter: parsed, body: source.slice(match[0].length).replace(/^\r?\n/, "") }
}

/**
 * Serialize fields and body in the file's format. Markdown without fields is the body alone. JSON is indented by two
 * spaces and YAML uses block style, so every field change is its own line in a diff.
 */
export function renderDocumentFile(frontmatter: Record<string, unknown>, body: string, format: ContentFormat = "markdown"): string {
  if (format === "json") return `${JSON.stringify(frontmatter, null, 2)}\n`
  if (format === "yaml") return stringifyYaml(frontmatter, yamlOptions)
  const keys = Object.keys(frontmatter).length
  // A body that starts with a delimiter needs an empty frontmatter block so it is not read back as frontmatter.
  if (!keys && !/^(?:\uFEFF)?---/.test(body)) return body
  return `---\n${keys ? stringifyYaml(frontmatter, yamlOptions) : ""}---\n${body ? `\n${body}` : ""}`
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
