import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Diagnostic } from "nostics"
import { isPlainRecord } from "@vite-hub/internal/object"

import { parseCollectionSchema } from "./schema.ts"
import type { CollectionCursorValue } from "./collection.ts"
import { sourceErrorDiagnostics } from "../error-diagnostics.ts"

export class CollectionCursorError extends Diagnostic {
  constructor(message = "[vitehub] Collection cursor is malformed.", options?: ErrorOptions) {
    super({
      cause: options?.cause,
      code: "SOURCE_R0023",
      docs: "https://vitehub.dev/docs/reference/diagnostics",
      why: message,
    }, CollectionCursorError)
    this.name = "CollectionCursorError"
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
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function hasPrimitiveRuntimeTag(value: unknown, tag: string): boolean {
  return value !== null && value !== undefined && Object(value) !== value && Object.prototype.toString.call(value) === tag
}

function isRuntimeNumber(value: unknown): value is number {
  return hasPrimitiveRuntimeTag(value, "[object Number]")
}

function isRuntimeObject(value: unknown): value is object {
  return value !== null && Object(value) === value
}

function isRuntimeString(value: unknown): value is string {
  return hasPrimitiveRuntimeTag(value, "[object String]")
}

function isCursorValue(value: unknown, ancestors = new Set<object>()): value is CollectionCursorValue {
  if (isRuntimeNumber(value)) return Number.isFinite(value) && !Object.is(value, -0)
  if (value === null || value === true || value === false || isRuntimeString(value)) return true
  if (!isRuntimeObject(value) || ancestors.has(value)) return false

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && !isRuntimeString(key))) return false
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor) || !isCursorValue(descriptor.value, ancestors)) return false
      }
      return true
    }

    if (!isPlainRecord(value)) return false
    for (const key of Reflect.ownKeys(value)) {
      if (!isRuntimeString(key)) return false
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
