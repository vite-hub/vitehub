import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorOptions } from "@vite-hub/runtime"

export type SourceErrorCode =
  | "SOURCE_CONTENT_MISSING"
  | "SOURCE_ITEM_IS_DIRECTORY"
  | "SOURCE_ITEM_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_PATH_INVALID"
  | "SOURCE_PROVIDER_REQUEST_FAILED"
  | "SOURCE_PROVIDER_RESPONSE_INVALID"

export type SourceProvider = "custom" | "filesystem" | "github" | "mcp"

export type SourceProviderOperation =
  | "close"
  | "connect"
  | "list"
  | "list-resources"
  | "metadata"
  | "read"
  | "read-archive"
  | "read-item"
  | "read-metadata"
  | "read-resource"
  | "resolve"
  | "resolve-ref"
  | "resolve-repository"
  | "resolve-root"
  | "validate-ref"

export type SourceValueType =
  | "array"
  | "bigint"
  | "boolean"
  | "date"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined"

type SourceErrorDetailMap = {
  SOURCE_CONTENT_MISSING: { readonly key?: string, readonly source?: string }
  SOURCE_ITEM_IS_DIRECTORY: { readonly key?: string, readonly source?: string }
  SOURCE_ITEM_NOT_FOUND: { readonly key?: string, readonly source?: string }
  SOURCE_NOT_FOUND: { readonly source?: string }
  SOURCE_PATH_INVALID: { readonly field: "path", readonly valueType: SourceValueType }
  SOURCE_PROVIDER_REQUEST_FAILED: { readonly operation: SourceProviderOperation, readonly provider: SourceProvider, readonly status?: number }
  SOURCE_PROVIDER_RESPONSE_INVALID: { readonly key?: string, readonly operation: SourceProviderOperation, readonly provider: SourceProvider }
}

export type SourceErrorDetails<TCode extends SourceErrorCode = SourceErrorCode> = SourceErrorDetailMap[TCode]

export interface SourceErrorOptions<TCode extends SourceErrorCode = SourceErrorCode> extends ViteHubErrorOptions<SourceErrorDetails<TCode>> {
  code: TCode
}

export class SourceError<TCode extends SourceErrorCode = SourceErrorCode> extends ViteHubError<TCode, SourceErrorDetails<TCode>> {
  constructor(options: SourceErrorOptions<TCode> & { message: string })
  constructor(message: string, options: SourceErrorOptions<TCode>)
  constructor(
    input: string | (SourceErrorOptions<TCode> & { message: string }),
    legacyOptions?: SourceErrorOptions<TCode>,
  ) {
    const { code: inputCode, message, ...options } = typeof input === "string"
      ? { ...legacyOptions!, message: input }
      : input
    const code = parseSourceErrorCode(inputCode) as TCode
    const details = parseSourceErrorDetails(code, options.details) as SourceErrorDetails<TCode> | undefined
    super(code, message, {
      cause: options.cause,
      ...(details === undefined ? {} : { details }),
      requestId: options.requestId,
      retryable: options.retryable,
    })
    this.name = "SourceError"
  }
}

export class SourceNotFoundError extends SourceError<"SOURCE_NOT_FOUND"> {
  constructor(name: string) {
    const source = normalizePublicSourceIdentifier(name)
    super({
      code: "SOURCE_NOT_FOUND",
      details: source ? { source } : undefined,
      message: source ? `[vitehub] Source "${source}" is not registered.` : "[vitehub] Source is not registered.",
    })
    this.name = "SourceNotFoundError"
  }
}

export class SourcePathError extends SourceError<"SOURCE_PATH_INVALID"> {
  constructor(path: unknown) {
    super({
      code: "SOURCE_PATH_INVALID",
      details: { field: "path", valueType: sourceValueType(path) },
      message: "[vitehub] Source path escapes the source root.",
    })
    this.name = "SourcePathError"
  }
}

export function sourceContentMissingError(source: string, key: string): SourceError<"SOURCE_CONTENT_MISSING"> {
  const details = sourceItemDetails(source, key)
  return new SourceError({
    code: "SOURCE_CONTENT_MISSING",
    details,
    message: sourceContentMissingMessage(details),
  })
}

export function sourceItemIsDirectoryError(source: string, key: string): SourceError<"SOURCE_ITEM_IS_DIRECTORY"> {
  const details = sourceItemDetails(source, key)
  return new SourceError({
    code: "SOURCE_ITEM_IS_DIRECTORY",
    details,
    message: sourceItemIsDirectoryMessage(details),
  })
}

export function sourceItemNotFoundError(source: string, key: string): SourceError<"SOURCE_ITEM_NOT_FOUND"> {
  const details = sourceItemDetails(source, key)
  return new SourceError({
    code: "SOURCE_ITEM_NOT_FOUND",
    details,
    message: sourceItemNotFoundMessage(details),
  })
}

export function sourceProviderRequestError(
  provider: SourceProvider,
  operation: SourceProviderOperation,
  options: { cause?: unknown, status?: number } = {},
): SourceError<"SOURCE_PROVIDER_REQUEST_FAILED"> {
  return new SourceError({
    cause: options.cause,
    code: "SOURCE_PROVIDER_REQUEST_FAILED",
    details: {
      operation,
      provider,
      ...(options.status === undefined ? {} : { status: options.status }),
    },
    message: `[vitehub] ${provider} source request failed during ${operation}.`,
  })
}

export function sourceProviderResponseInvalidError(
  provider: SourceProvider,
  operation: SourceProviderOperation,
  options: { cause?: unknown, key?: string } = {},
): SourceError<"SOURCE_PROVIDER_RESPONSE_INVALID"> {
  const key = normalizePublicSourceIdentifier(options.key)
  return new SourceError({
    cause: options.cause,
    code: "SOURCE_PROVIDER_RESPONSE_INVALID",
    details: {
      operation,
      provider,
      ...(key === undefined ? {} : { key }),
    },
    message: `[vitehub] ${provider} source returned an invalid response during ${operation}.`,
  })
}

function sourceValueType(value: unknown): SourceValueType {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (value instanceof Date) return "date"
  return typeof value
}

function normalizePublicSourceIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.trim() !== value) return
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
  if (normalized !== value) return
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^[a-z]:\//i.test(value)) return
  if ([...value].some(character => character.codePointAt(0)! <= 31 || character.codePointAt(0) === 127)) return
  const parts = value.split("/")
  if (parts.some(part => part === "." || part === "..")) return
  return value
}

function sourceItemDetails(source: unknown, key: unknown) {
  const safeSource = normalizePublicSourceIdentifier(source)
  const safeKey = normalizePublicSourceIdentifier(key)
  return {
    ...(safeKey === undefined ? {} : { key: safeKey }),
    ...(safeSource === undefined ? {} : { source: safeSource }),
  }
}

function parseSourceErrorCode(value: unknown): SourceErrorCode {
  switch (value) {
    case "SOURCE_CONTENT_MISSING":
    case "SOURCE_ITEM_IS_DIRECTORY":
    case "SOURCE_ITEM_NOT_FOUND":
    case "SOURCE_NOT_FOUND":
    case "SOURCE_PATH_INVALID":
    case "SOURCE_PROVIDER_REQUEST_FAILED":
    case "SOURCE_PROVIDER_RESPONSE_INVALID":
      return value
    default:
      throw new TypeError("[vitehub] Invalid Source error code.")
  }
}

function parseSourceErrorDetails(
  code: SourceErrorCode,
  value: unknown,
): SourceErrorDetails | undefined {
  if (value === undefined) return
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("[vitehub] Invalid Source error details.")
  }

  try {
    const details = value as Record<string, unknown>
    switch (code) {
      case "SOURCE_CONTENT_MISSING":
      case "SOURCE_ITEM_IS_DIRECTORY":
      case "SOURCE_ITEM_NOT_FOUND":
        return sourceItemDetails(details.source, details.key)
      case "SOURCE_NOT_FOUND": {
        const source = normalizePublicSourceIdentifier(details.source)
        return source === undefined ? {} : { source }
      }
      case "SOURCE_PATH_INVALID":
        if (details.field !== "path") throw new TypeError()
        return { field: "path", valueType: parseSourceValueType(details.valueType) }
      case "SOURCE_PROVIDER_REQUEST_FAILED": {
        const status = details.status
        if (status !== undefined && (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599)) {
          throw new TypeError()
        }
        return {
          operation: parseSourceProviderOperation(details.operation),
          provider: parseSourceProvider(details.provider),
          ...(status === undefined ? {} : { status: status as number }),
        }
      }
      case "SOURCE_PROVIDER_RESPONSE_INVALID": {
        const key = normalizePublicSourceIdentifier(details.key)
        return {
          ...(key === undefined ? {} : { key }),
          operation: parseSourceProviderOperation(details.operation),
          provider: parseSourceProvider(details.provider),
        }
      }
    }
  }
  catch {
    throw new TypeError("[vitehub] Invalid Source error details.")
  }
}

function parseSourceProvider(value: unknown): SourceProvider {
  switch (value) {
    case "custom":
    case "filesystem":
    case "github":
    case "mcp":
      return value
    default:
      throw new TypeError()
  }
}

function parseSourceProviderOperation(value: unknown): SourceProviderOperation {
  switch (value) {
    case "close":
    case "connect":
    case "list":
    case "list-resources":
    case "metadata":
    case "read":
    case "read-archive":
    case "read-item":
    case "read-metadata":
    case "read-resource":
    case "resolve":
    case "resolve-ref":
    case "resolve-repository":
    case "resolve-root":
    case "validate-ref":
      return value
    default:
      throw new TypeError()
  }
}

function parseSourceValueType(value: unknown): SourceValueType {
  switch (value) {
    case "array":
    case "bigint":
    case "boolean":
    case "date":
    case "function":
    case "null":
    case "number":
    case "object":
    case "string":
    case "symbol":
    case "undefined":
      return value
    default:
      throw new TypeError()
  }
}

function sourceContentMissingMessage(details: { key?: string, source?: string }): string {
  const owner = details.source || "Source"
  return details.key
    ? `[vitehub] ${owner} did not include content for ${JSON.stringify(details.key)}.`
    : `[vitehub] ${owner} did not include readable content.`
}

function sourceItemIsDirectoryMessage(details: { key?: string, source?: string }): string {
  const owner = details.source || "Source"
  return details.key
    ? `[vitehub] ${owner} expected ${JSON.stringify(details.key)} to be a file, but it is a directory.`
    : `[vitehub] ${owner} returned a directory instead of a file.`
}

function sourceItemNotFoundMessage(details: { key?: string, source?: string }): string {
  const owner = details.source || "Source"
  return details.key
    ? `[vitehub] ${owner} could not find ${JSON.stringify(details.key)}.`
    : `[vitehub] ${owner} could not find the requested item.`
}
