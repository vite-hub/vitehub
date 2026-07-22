export type ViteHubErrorDetail =
  | boolean
  | null
  | number
  | string
  | readonly ViteHubErrorDetail[]
  | { readonly [key: string]: ViteHubErrorDetail | undefined }

export type ViteHubErrorDetails = Readonly<Record<string, ViteHubErrorDetail | undefined>>

export interface ViteHubErrorShape<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> {
  code: TCode
  details?: TDetails
  message: string
  name: "ViteHubError"
  requestId?: string
}

export interface ViteHubErrorOptions<TDetails extends ViteHubErrorDetails = ViteHubErrorDetails> extends ErrorOptions {
  details?: TDetails
  requestId?: string
}

const MAX_DETAIL_DEPTH = 8
const MAX_DETAIL_ENTRIES = 128
const MAX_DETAIL_KEY_LENGTH = 128
const MAX_DETAIL_NODES = 1024
const MAX_DETAIL_STRING_LENGTH = 16_384
const MAX_ERROR_CODE_LENGTH = 128
const MAX_ERROR_MESSAGE_LENGTH = 16_384
const MAX_REQUEST_ID_LENGTH = 256

const publicShapes = new WeakMap<object, ViteHubErrorShape>()

function invalidPublicError(): never {
  throw new TypeError("[vitehub] ViteHubError requires a valid public error contract.")
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value)
  }
  catch {
    invalidPublicError()
  }
}

function readOwnDataProperty(value: object, key: PropertyKey, requireEnumerable = false): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || (requireEnumerable && !descriptor.enumerable)) invalidPublicError()
    return descriptor.value
  }
  catch {
    invalidPublicError()
  }
}

interface DetailCloneState {
  ancestors: Set<object>
  nodes: number
}

function clonePublicDetail(
  value: unknown,
  state: DetailCloneState,
  depth: number,
  allowUndefined: boolean,
): ViteHubErrorDetail | undefined {
  state.nodes += 1
  if (state.nodes > MAX_DETAIL_NODES) invalidPublicError()
  if (value === undefined && allowUndefined) return undefined
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string" && value.length <= MAX_DETAIL_STRING_LENGTH) return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || depth > MAX_DETAIL_DEPTH || state.ancestors.has(value)) invalidPublicError()

  let prototype: object | null
  let keys: PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  }
  catch {
    invalidPublicError()
  }

  state.ancestors.add(value)
  try {
    if (isArray(value)) {
      const length = readOwnDataProperty(value, "length")
      if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > MAX_DETAIL_ENTRIES || keys.length !== (length as number) + 1 || !keys.includes("length")) invalidPublicError()
      const result: ViteHubErrorDetail[] = []
      for (let index = 0; index < (length as number); index += 1) {
        const key = String(index)
        if (!keys.includes(key)) invalidPublicError()
        result.push(clonePublicDetail(readOwnDataProperty(value, key, true), state, depth + 1, false)!)
      }
      return Object.freeze(result)
    }

    if (prototype !== Object.prototype && prototype !== null) invalidPublicError()
    if (keys.length > MAX_DETAIL_ENTRIES || keys.some(key => typeof key !== "string")) invalidPublicError()
    const result: Record<string, ViteHubErrorDetail | undefined> = {}
    for (const key of keys as string[]) {
      if (key.length === 0 || key.length > MAX_DETAIL_KEY_LENGTH) invalidPublicError()
      Object.defineProperty(result, key, {
        enumerable: true,
        value: clonePublicDetail(readOwnDataProperty(value, key, true), state, depth + 1, true),
        writable: true,
      })
    }
    return Object.freeze(result)
  }
  finally {
    state.ancestors.delete(value)
  }
}

function clonePublicDetails(value: unknown): ViteHubErrorDetails | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || isArray(value)) invalidPublicError()
  return clonePublicDetail(value, { ancestors: new Set(), nodes: 0 }, 0, false) as ViteHubErrorDetails
}

interface NormalizedPublicError {
  cause?: unknown
  code: string
  details?: ViteHubErrorDetails
  message: string
  name: "ViteHubError"
  requestId?: string
  shape: ViteHubErrorShape
}

function normalizePublicError(code: unknown, message: unknown, options: unknown): NormalizedPublicError {
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_ERROR_CODE_LENGTH) invalidPublicError()
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_ERROR_MESSAGE_LENGTH) invalidPublicError()
  if (typeof options !== "object" || options === null || isArray(options)) invalidPublicError()

  const cause = readOwnDataProperty(options, "cause")
  const details = clonePublicDetails(readOwnDataProperty(options, "details"))
  const requestId = readOwnDataProperty(options, "requestId")
  if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH)) invalidPublicError()

  const shape = Object.freeze({
    code,
    ...(details === undefined ? {} : { details }),
    message,
    name: "ViteHubError" as const,
    ...(requestId === undefined ? {} : { requestId }),
  })
  return { cause, code, details, message, name: "ViteHubError", requestId, shape }
}

export class ViteHubError<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends Error {
  readonly code: TCode
  readonly details?: TDetails
  readonly requestId?: string

  constructor(code: TCode, message: string, options: ViteHubErrorOptions<TDetails> = {}) {
    const normalized = normalizePublicError(code, message, options)
    super(normalized.message, normalized.cause === undefined ? undefined : { cause: normalized.cause })
    this.name = "ViteHubError"
    this.code = normalized.code as TCode
    this.details = normalized.details as TDetails | undefined
    this.requestId = normalized.requestId
    const toJSON = this.toJSON.bind(this)
    Object.defineProperties(this, {
      code: { configurable: true, enumerable: true, value: normalized.code, writable: false },
      details: { configurable: true, enumerable: true, value: normalized.details, writable: false },
      message: { configurable: true, enumerable: false, value: normalized.message, writable: false },
      name: { configurable: false, enumerable: false, value: normalized.name, writable: false },
      requestId: { configurable: true, enumerable: true, value: normalized.requestId, writable: false },
      toJSON: { configurable: false, enumerable: false, value: toJSON, writable: false },
    })
    publicShapes.set(this, normalized.shape)
  }

  toJSON(): ViteHubErrorShape<TCode, TDetails> {
    const existing = publicShapes.get(this)
    if (existing) return existing as ViteHubErrorShape<TCode, TDetails>

    const normalized = normalizePublicError(
      readOwnDataProperty(this, "code"),
      readOwnDataProperty(this, "message"),
      {
        details: readOwnDataProperty(this, "details"),
        requestId: readOwnDataProperty(this, "requestId"),
      },
    )
    publicShapes.set(this, normalized.shape)
    return normalized.shape as ViteHubErrorShape<TCode, TDetails>
  }
}

export function getViteHubErrorShape(value: unknown): ViteHubErrorShape | undefined {
  if (typeof value !== "object" || value === null) return
  try {
    const existing = publicShapes.get(value)
    if (existing) return existing
    if (readOwnDataProperty(value, "name") !== "ViteHubError") return
    return normalizePublicError(
      readOwnDataProperty(value, "code"),
      readOwnDataProperty(value, "message"),
      {
        details: readOwnDataProperty(value, "details"),
        requestId: readOwnDataProperty(value, "requestId"),
      },
    ).shape
  }
  catch {
    return
  }
}

export function isViteHubError(value: unknown): value is ViteHubErrorShape {
  return getViteHubErrorShape(value) !== undefined
}
