import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Diagnostic } from "nostics"
import { isPlainRecord } from "@vite-hub/internal/object"

import { parseCollectionSchema } from "./schema.ts"
import type { CollectionCursorValue } from "./collection.ts"
import { sourceErrorDiagnostics } from "../error-diagnostics.ts"

/** Why a Collection rejected a cursor: it cannot be decoded, or it belongs to other data or another query. */
export type CollectionCursorErrorReason = "malformed" | "stale"

export interface CollectionCursorErrorOptions extends ErrorOptions {
  reason?: CollectionCursorErrorReason
}

/** A Collection cursor was rejected. Routes answer `400` for `malformed` and `409` for `stale`. */
export class CollectionCursorError extends Diagnostic {
  readonly reason: CollectionCursorErrorReason

  constructor(message?: string, options?: CollectionCursorErrorOptions) {
    const reason = options?.reason ?? "malformed"
    super({
      cause: options?.cause,
      code: reason === "stale" ? "SOURCE_R0027" : "SOURCE_R0023",
      docs: `https://vitehub.dev/docs/source/diagnostics/${reason === "stale" ? "source_r0027" : "source_r0023"}`,
      why: message ?? (reason === "stale"
        ? "[vitehub] Collection cursor is stale. Its data or query changed; reload from the first page."
        : "[vitehub] Collection cursor is malformed."),
    }, CollectionCursorError)
    this.name = "CollectionCursorError"
    this.reason = reason
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function decodeBase64Url(value: string): string {
  // Collection cursors are emitted as unpadded base64url. Reject malformed
  // padding and lengths before host-specific decoders can silently accept them.
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new TypeError("Malformed base64url cursor")
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") !== value) throw new TypeError("Noncanonical base64url cursor")
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value
}

function isCursorValue(value: unknown, ancestors = new Set<object>()): value is CollectionCursorValue {
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0)
  if (value === null || value === true || value === false || typeof value === "string") return true
  if (!isRuntimeObject(value) || ancestors.has(value)) return false

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && typeof key !== "string")) return false
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor) || !isCursorValue(descriptor.value, ancestors)) return false
      }
      return true
    }

    if (!isPlainRecord(value)) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor) || !isCursorValue(descriptor.value, ancestors)) return false
    }
    return true
  } catch {
    return false
  } finally {
    ancestors.delete(value)
  }
}

function encodeCursor(value: CollectionCursorValue): string {
  if (!isCursorValue(value)) {
    throw sourceErrorDiagnostics.SOURCE_R0005({ message: "[vitehub] Collection cursor() must return a JSON-serializable value." })
  }
  return encodeBase64Url(JSON.stringify(value))
}

async function decodeCursor<TCursorInput extends CollectionCursorValue, TCursorOutput extends CollectionCursorValue>(
  value: string | undefined,
  schema: StandardSchemaV1<TCursorInput, TCursorOutput>,
): Promise<TCursorOutput | undefined> {
  if (value === undefined) return
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeBase64Url(value))
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
  if (!isCursorValue(decoded)) throw new CollectionCursorError()
  try {
    const cursor = await parseCollectionSchema(schema, decoded)
    if (!isCursorValue(cursor)) {
      throw sourceErrorDiagnostics.SOURCE_R0007({ message: "Collection cursor schema returned an invalid value." })
    }
    return cursor
  } catch (cause) {
    throw new CollectionCursorError(undefined, { cause })
  }
}

/** Bind cursor transport and validation to the Collection's schema once. */
export function createCollectionCursorCodec<TInput extends CollectionCursorValue, TOutput extends CollectionCursorValue>(
  schema: StandardSchemaV1<TInput, TOutput>,
) {
  return {
    encode(value: TInput): string {
      return encodeCursor(value)
    },
    decode(value: string | undefined): Promise<TOutput | undefined> {
      return decodeCursor(value, schema)
    },
  }
}
