// Blob reference schemas: Standard Schema validators for a stored pointer to one Blob object.
import { isPlainObject } from "@vite-hub/internal/object"

import { blobSizeToBytes } from "./internal/size.ts"

import type { BlobObject, BlobSize, BlobStoreName } from "./types.ts"

/**
 * The stored form of one Blob object: its pathname in a Blob Store, plus the content type and size
 * recorded at upload. A reference never stores a URL; serve or sign the pathname when you read it.
 */
export interface BlobReference {
  pathname: string
  contentType?: string
  size?: number
}

/**
 * What a reference schema accepts. A `BlobObject` from `put()` or `handleUpload()` fits, and its
 * other fields are dropped from the validated value.
 */
export type BlobReferenceInput = Pick<BlobObject, "pathname"> & {
  contentType?: string | undefined
  size?: number | undefined
}

export type BlobReferenceKind = "file" | "image"

export interface BlobReferenceOptions {
  /** Named Blob Store that holds the object. Defaults to `"default"`. */
  store?: BlobStoreName
  /** Accepted MIME types, such as `"image/png"`, `"image/*"`, or `"*\/*"`. `image()` defaults to `"image/*"`. */
  accept?: string | string[]
  /** Largest recorded `size` to accept, such as `"8MB"`. Units are powers of 1024. */
  maxSize?: BlobSize
}

/** The `x-vitehub-blob` JSON Schema keyword. Forms read it to render a Blob picker. */
export interface BlobReferenceHint {
  kind: BlobReferenceKind
  store: BlobStoreName
  /** Present when the schema restricts content types. */
  accept?: string[]
  /** Present when the schema limits the size, as given in the options. */
  maxSize?: BlobSize
}

export interface BlobReferenceIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey>
}

export type BlobReferenceResult =
  | { readonly value: BlobReference, readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<BlobReferenceIssue> }

/** JSON Schema targets that a reference schema can emit. Other targets throw, as Standard JSON Schema requires. */
export type BlobReferenceJsonSchemaTarget = "draft-07" | "draft-2020-12" | "openapi-3.0"

export interface BlobReferenceJsonSchemaOptions {
  readonly target: BlobReferenceJsonSchemaTarget | (string & {})
  readonly libraryOptions?: Record<string, unknown> | undefined
}

/** A Standard Schema and Standard JSON Schema for one Blob reference. */
export interface BlobReferenceSchema {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: "vitehub"
    readonly validate: (value: unknown) => BlobReferenceResult
    readonly types?: { readonly input: BlobReferenceInput, readonly output: BlobReference } | undefined
    readonly jsonSchema: {
      readonly input: (options: BlobReferenceJsonSchemaOptions) => Record<string, unknown>
      readonly output: (options: BlobReferenceJsonSchemaOptions) => Record<string, unknown>
    }
  }
}

const jsonSchemaTargets = new Set<string>(["draft-07", "draft-2020-12", "openapi-3.0"])
const mimePattern = /^(?:\*\/\*|[a-z0-9!#$&^_.+-]+\/(?:\*|[a-z0-9!#$&^_.+-]+))$/

function isString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Reference values come from documents, forms, and request bodies.
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Reference values come from documents, forms, and request bodies.
  return typeof value === "number"
}

function label(kind: BlobReferenceKind): string {
  return kind === "image" ? "Image" : "File"
}

function resolveAccept(kind: BlobReferenceKind, accept: BlobReferenceOptions["accept"]): string[] | undefined {
  const list = accept === undefined ? (kind === "image" ? ["image/*"] : []) : [accept].flat()
  const patterns = list.map(pattern => pattern.trim().toLowerCase())
  for (const pattern of patterns) {
    if (!mimePattern.test(pattern)) {
      throw new TypeError(`[vitehub] ${kind}() accept entry "${pattern}" is not a MIME type or pattern such as "image/png" or "image/*".`)
    }
  }
  return patterns.length && !patterns.includes("*/*") ? patterns : undefined
}

const mimeValuePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i

function accepts(patterns: string[], contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase()
  if (!mimeValuePattern.test(type)) return false
  const major = type.split("/")[0]
  return patterns.some(pattern => pattern === type || (pattern.endsWith("/*") && pattern.slice(0, -2) === major))
}

function caseInsensitivePattern(value: string): string {
  const special = "\\^$.*+?()[]{}|"
  return [...value].map(character => {
    if (/[a-z]/i.test(character)) return "[" + character.toLowerCase() + character.toUpperCase() + "]"
    return special.includes(character) ? "\\" + character : character
  }).join("")
}

const pathnamePattern = String.raw`^(?!/)(?!.*\\)(?!.*[\u0000-\u001F\u007F])(?!.*(?:^|/)\.{1,2}(?:/|$))(?!.*//)(?!.*\/$)(?!_[Vv][Ii][Tt][Ee][Hh][Uu][Bb](?:$|/[Dd][Ee][Rr][Ii][Vv][Ee][Dd](?:/|$))).+`

function contentTypeSchema(accept: string[] | undefined): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: "string",
    minLength: 1,
    description: "MIME type recorded at upload.",
  }
  if (!accept) return schema
  const patterns = accept.map(pattern => {
    if (pattern.endsWith("/*")) return `^\\s*${caseInsensitivePattern(pattern.slice(0, -2))}/[a-zA-Z0-9!#$&^_.+-]+(?:\\s*;[\\s\\S]*)?\\s*$`
    return `^\\s*${caseInsensitivePattern(pattern)}(?:\\s*;[\\s\\S]*)?\\s*$`
  })
  if (patterns.length === 1) schema.pattern = patterns[0]
  else schema.anyOf = patterns.map(pattern => ({ pattern }))
  return schema
}

function pathnameIssue(pathname: string): string | undefined {
  if (!pathname) return "Blob pathname must not be empty."
  if (pathname.startsWith("/")) return "Blob pathname must be relative to its Blob Store, without a leading slash."
  if (pathname.includes("\\")) return "Blob pathname must use forward slashes."
  // Control characters make pathnames ambiguous in URLs, headers, and provider keys.
  if ([...pathname].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7F)) return "Blob pathname must not contain control characters."
  const segments = pathname.split("/")
  if (segments.some(segment => segment === "." || segment === "..")) return "Blob pathname must not contain \".\" or \"..\" segments."
  if (segments.some(segment => !segment)) return "Blob pathname must not contain empty segments or a trailing slash."
  // Matches the namespace that blob.put() reserves for derived cache objects.
  if (segments[0]!.toLowerCase() === "_vitehub" && (segments.length === 1 || segments[1]!.toLowerCase() === "derived")) {
    return "Blob pathname must not point into the reserved _vitehub/derived namespace."
  }
  return undefined
}

function referenceJsonSchema(hint: BlobReferenceHint, maxBytes: number | undefined, direction: "input" | "output", options: BlobReferenceJsonSchemaOptions): Record<string, unknown> {
  if (!jsonSchemaTargets.has(options.target)) {
    throw new Error(`[vitehub] Blob reference schemas emit draft-07, draft-2020-12, or openapi-3.0 JSON Schema, not "${options.target}".`)
  }
  const description = "Size in bytes recorded at upload."
  const size = maxBytes === undefined
    ? { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description }
    : { type: "integer", minimum: 0, maximum: maxBytes, description }
  const properties = {
    pathname: { type: "string", minLength: 1, pattern: pathnamePattern, description: "Pathname in the Blob Store." },
    contentType: contentTypeSchema(hint.accept),
    size,
  }
  const required = hint.accept ? ["pathname", "contentType"] : ["pathname"]
  const blobHint = hint.accept ? { ...hint, accept: [...hint.accept] } : { ...hint }
  // Validation drops extra fields, so the output never has them.
  return direction === "output"
    ? { type: "object", properties, required, additionalProperties: false, "x-vitehub-blob": blobHint }
    : { type: "object", properties, required, "x-vitehub-blob": blobHint }
}

function createReferenceSchema(kind: BlobReferenceKind, options: BlobReferenceOptions = {}): BlobReferenceSchema {
  const store = options.store ?? "default"
  if (!isString(store) || !store) throw new TypeError(`[vitehub] ${kind}() store must be a non-empty Blob Store name.`)
  const accept = resolveAccept(kind, options.accept)
  const maxBytes = options.maxSize === undefined ? undefined : blobSizeToBytes(options.maxSize)
  if (options.maxSize !== undefined && maxBytes === undefined) {
    throw new TypeError(`[vitehub] ${kind}() maxSize "${options.maxSize}" is not a size such as "512KB" or "8MB".`)
  }
  const hint: BlobReferenceHint = { kind, store }
  if (accept) hint.accept = accept
  if (options.maxSize !== undefined) hint.maxSize = options.maxSize

  function validate(value: unknown): BlobReferenceResult {
    if (!isPlainObject(value)) {
      return { issues: [{ message: `${label(kind)} must be a Blob reference object with a pathname, such as the result of blob.put().` }] }
    }
    const issues: BlobReferenceIssue[] = []
    const { pathname, contentType, size } = value
    if (!isString(pathname)) {
      issues.push({ message: "Blob pathname must be a string.", path: ["pathname"] })
    }
    else {
      const message = pathnameIssue(pathname)
      if (message) issues.push({ message, path: ["pathname"] })
    }
    if (contentType !== undefined && (!isString(contentType) || !contentType.trim())) {
      issues.push({ message: "Blob contentType must be a non-empty string.", path: ["contentType"] })
    }
    else if (accept && contentType === undefined) {
      issues.push({ message: `${label(kind)} needs a contentType to check it against ${accept.join(", ")}.`, path: ["contentType"] })
    }
    else if (accept && isString(contentType) && !accepts(accept, contentType)) {
      issues.push({ message: `${label(kind)} type "${contentType}" is not accepted. Accepted types: ${accept.join(", ")}.`, path: ["contentType"] })
    }
    if (size !== undefined && (!isNumber(size) || !Number.isSafeInteger(size) || size < 0)) {
      issues.push({ message: "Blob size must be a non-negative integer number of bytes.", path: ["size"] })
    }
    else if (maxBytes !== undefined && isNumber(size) && size > maxBytes) {
      issues.push({ message: `${label(kind)} is ${size} bytes, larger than maxSize ${options.maxSize} (${maxBytes} bytes).`, path: ["size"] })
    }
    if (issues.length || !isString(pathname)) return { issues }
    const reference: BlobReference = { pathname }
    if (isString(contentType)) reference.contentType = contentType
    if (isNumber(size)) reference.size = size
    return { value: reference }
  }

  return {
    "~standard": {
      version: 1,
      vendor: "vitehub",
      validate,
      jsonSchema: {
        input: options => referenceJsonSchema(hint, maxBytes, "input", options),
        output: options => referenceJsonSchema(hint, maxBytes, "output", options),
      },
    },
  }
}

/**
 * A Standard Schema for a reference to an image in a Blob Store. Accepts `image/*` unless `accept` says otherwise.
 * The JSON Schema carries an `x-vitehub-blob` hint so a form can render an image picker.
 */
export function image(options?: BlobReferenceOptions): BlobReferenceSchema {
  return createReferenceSchema("image", options)
}

/**
 * A Standard Schema for a reference to any object in a Blob Store. Accepts every content type unless `accept` is set.
 * The JSON Schema carries an `x-vitehub-blob` hint so a form can render a file picker.
 */
export function file(options?: BlobReferenceOptions): BlobReferenceSchema {
  return createReferenceSchema("file", options)
}
