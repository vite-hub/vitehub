import { deserializeResponse, isSerializedResponse } from '@vite-hub/runtime'
import { hasRuntimeType } from '@vite-hub/runtime/internal/runtime-type'
import { isSandboxError, sandboxError } from '../sandbox/errors'
import type { SandboxExecutionBox } from './execution-box'

export const SANDBOX_VALUE_MARKER = 'vitehub:sandbox:value'

type BinaryDescriptor = {
  id: number
  kind: 'blob' | 'buffer' | 'uint8array'
  tag: 'binary'
  type?: string
}

type ObjectDescriptor = {
  entries: Array<[string, unknown]>
  tag: 'object'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

const typedArrayTagGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get
const blobSizeGetter = typeof Blob !== 'undefined'
  ? Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get
  : undefined
const blobArrayBufferMethod = typeof Blob !== 'undefined'
  ? Object.getOwnPropertyDescriptor(Blob.prototype, 'arrayBuffer')?.value
  : undefined

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && typedArrayTagGetter?.call(value) === 'Uint8Array'
}

function unboxJsonPrimitive(value: unknown): { value: unknown } | undefined {
  for (const unbox of [Boolean.prototype.valueOf, Number.prototype.valueOf, String.prototype.valueOf, BigInt.prototype.valueOf]) {
    try {
      return { value: Reflect.apply(unbox, value, []) }
    }
    catch {}
  }
  return undefined
}

function hasMarker(value: Record<string, unknown>) {
  return Object.prototype.hasOwnProperty.call(value, SANDBOX_VALUE_MARKER)
}

function tagged(value: BinaryDescriptor | ObjectDescriptor) {
  return { [SANDBOX_VALUE_MARKER]: value }
}

function serializationError(message: string, details?: Record<string, unknown>, cause?: unknown) {
  return sandboxError(message, {
    code: 'SANDBOX_SERIALIZATION_ERROR',
    cause,
    details,
  })
}

export interface SandboxTransferLimits {
  maxDepth: number
  maxSidecars: number
  maxSidecarBytes: number
}

export interface EncodedSandboxValue {
  value: unknown
  writeSidecars: () => Promise<void>
}

export const DEFAULT_SANDBOX_TRANSFER_LIMITS: SandboxTransferLimits = {
  maxDepth: 32,
  maxSidecars: 64,
  maxSidecarBytes: 64 * 1024 * 1024,
}

function transferLimitError(label: string, limit: string, value: number, maximum: number) {
  return sandboxError(`Sandbox ${label} exceeds its ${limit} limit (${value} > ${maximum}).`, {
    code: 'SANDBOX_TRANSFER_LIMIT',
    details: { label, limit, value, maximum },
  })
}

export async function encodeSandboxValueStaged(
  sandbox: SandboxExecutionBox,
  value: unknown,
  assetsDir: string,
  label: string,
  signal?: AbortSignal,
  limits: SandboxTransferLimits = DEFAULT_SANDBOX_TRANSFER_LIMITS,
) {
  const state: { directory?: Promise<void>, nextId: number, sidecarBytes: number, pendingWrites: Array<{ id: number, bytes: Uint8Array }> } = { nextId: 0, sidecarBytes: 0, pendingWrites: [] }
  const throwIfAborted = () => signal?.throwIfAborted()
  const abortable = async <T>(operation: Promise<T>) => {
    try {
      return await operation
    }
    catch (error) {
      throwIfAborted()
      throw error
    }
  }

  async function encode(entry: unknown, ancestors: ReadonlySet<object>, key = '', applyToJSON = true, depth = 0): Promise<unknown> {
    if (depth > limits.maxDepth)
      throw transferLimitError(label, 'maxDepth', depth, limits.maxDepth)
    const blob = typeof Blob !== 'undefined' && entry instanceof Blob
    if (blob && Object.getPrototypeOf(entry) !== Blob.prototype)
      throw serializationError(`Sandbox ${label} Blob subclasses are not supported.`, { label })
    if (blob && Object.prototype.hasOwnProperty.call(entry, 'arrayBuffer'))
      throw serializationError(`Sandbox ${label} Blob arrayBuffer overrides are not supported.`, { label })
    const buffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(entry)
    if (blob || isUint8Array(entry)) {
      throwIfAborted()
      if (state.nextId + 1 > limits.maxSidecars)
        throw transferLimitError(label, 'maxSidecars', state.nextId + 1, limits.maxSidecars)
      const id = state.nextId++
      // SAFETY: The branch accepts only Blob or Uint8Array, and blob identifies the Blob case.
      // Read the intrinsic Blob size so an own `size` property cannot underreport
      // the allocation that arrayBuffer() will materialize.
      const byteLength = blob
        ? Reflect.apply(blobSizeGetter!, entry as Blob, []) as number
        : (entry as Uint8Array).byteLength
      if (state.sidecarBytes + byteLength > limits.maxSidecarBytes)
        throw transferLimitError(label, 'maxSidecarBytes', state.sidecarBytes + byteLength, limits.maxSidecarBytes)
      state.sidecarBytes += byteLength
      const bytes = blob
        ? new Uint8Array(await Reflect.apply(blobArrayBufferMethod!, entry as Blob, []))
        : entry as Uint8Array
      throwIfAborted()
      // A Blob can override `arrayBuffer()` even when its intrinsic size was
      // within the allowance. Account for the materialized bytes before
      // staging them so the aggregate bound cannot be bypassed.
      const materializedBytes = bytes.byteLength
      const accountedBytes = state.sidecarBytes - byteLength + materializedBytes
      if (accountedBytes > limits.maxSidecarBytes)
        throw transferLimitError(label, 'maxSidecarBytes', accountedBytes, limits.maxSidecarBytes)
      state.sidecarBytes = accountedBytes
      state.pendingWrites.push({ id, bytes })
      return tagged({
        id,
        kind: blob ? 'blob' : buffer ? 'buffer' : 'uint8array',
        ...(blob && (entry as Blob).type ? { type: (entry as Blob).type } : {}),
        tag: 'binary',
      })
    }

    if (isObjectRecord(entry) && applyToJSON && typeof entry.toJSON === 'function') {
      try {
        const replacement = Reflect.apply(entry.toJSON, entry, [key])
        const replacementDepth = replacement !== null && typeof replacement === 'object' ? depth + 1 : depth
        return await encode(replacement, ancestors, key, false, replacementDepth)
      }
      catch (error) {
        if (isSandboxError(error)) throw error
        throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label }, error)
      }
    }

    if (Array.isArray(entry)) {
      if (ancestors.has(entry))
        throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label })
      const nextAncestors = new Set(ancestors).add(entry)
      const encoded: unknown[] = []
      for (const [index, item] of entry.entries())
        encoded.push(await encode(item, nextAncestors, String(index), true, depth + 1))
      return encoded
    }

    if (!isObjectRecord(entry)) return entry
    const boxed = unboxJsonPrimitive(entry)
    if (boxed) return await encode(boxed.value, ancestors, key, false, depth)
    if (ancestors.has(entry))
      throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label })

    const nextAncestors = new Set(ancestors).add(entry)
    let sourceEntries: Array<[string, unknown]>
    try {
      sourceEntries = Object.entries(entry).filter(([entryKey, item]) => applyToJSON || entryKey !== 'toJSON' || typeof item !== 'function')
    }
    catch (error) {
      throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label }, error)
    }
    const entries: Array<[string, unknown]> = []
    for (const [entryKey, item] of sourceEntries)
      entries.push([entryKey, await encode(item, nextAncestors, entryKey, true, depth + 1)])
    return hasMarker(entry) ? tagged({ entries, tag: 'object' }) : Object.fromEntries(entries)
  }

  const encoded = await encode(value, new Set())
  return {
    value: encoded,
    async writeSidecars() {
      if (!state.pendingWrites.length) return
      state.directory ||= abortable(sandbox.files.mkdir(assetsDir, { recursive: true, signal }))
      await state.directory
      await Promise.all(state.pendingWrites.map(({ id, bytes }) => abortable(sandbox.files.write(`${assetsDir}/${id}`, bytes, { signal }))))
    },
  } satisfies EncodedSandboxValue
}

/** Encode a value and persist its binary sidecars immediately. */
export async function encodeSandboxValue(
  sandbox: SandboxExecutionBox,
  value: unknown,
  assetsDir: string,
  label: string,
  signal?: AbortSignal,
  limits: SandboxTransferLimits = DEFAULT_SANDBOX_TRANSFER_LIMITS,
) {
  const encoded = await encodeSandboxValueStaged(sandbox, value, assetsDir, label, signal, limits)
  await encoded.writeSidecars()
  return encoded.value
}

export async function decodeSandboxValue(
  sandbox: SandboxExecutionBox,
  value: unknown,
  assetsDir: string,
  label: string,
  signalOrLimits?: AbortSignal | SandboxTransferLimits,
  limits: SandboxTransferLimits = DEFAULT_SANDBOX_TRANSFER_LIMITS,
): Promise<unknown> {
  const signal = signalOrLimits && 'maxDepth' in signalOrLimits
    ? undefined
    : signalOrLimits
  if (signalOrLimits && 'maxDepth' in signalOrLimits)
    limits = signalOrLimits
  const state = { sidecars: 0, sidecarBytes: 0 }
  const readSidecar = async (path: string) => {
    try {
      return await sandbox.files.read(path, { signal })
    }
    catch (error) {
      signal?.throwIfAborted()
      throw error
    }
  }
  async function decode(entry: unknown, depth: number): Promise<unknown> {
    if (depth > limits.maxDepth)
      throw transferLimitError(label, 'maxDepth', depth, limits.maxDepth)
    if (Array.isArray(entry)) {
      const decoded: unknown[] = []
      for (const item of entry) decoded.push(await decode(item, depth + 1))
      return decoded
    }
    if (!isPlainObject(entry)) return entry

    if (!hasMarker(entry)) {
      const decoded: Array<[string, unknown]> = []
      for (const [key, item] of Object.entries(entry)) decoded.push([key, await decode(item, depth + 1)])
      return Object.fromEntries(decoded)
    }

    const descriptor = entry[SANDBOX_VALUE_MARKER]
    if (!isPlainObject(descriptor) || !hasRuntimeType(descriptor.tag, 'string'))
      throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })

    if (descriptor.tag === 'response') {
      if (!isSerializedResponse(descriptor.value))
        throw serializationError(`Sandbox ${label} contains an invalid response descriptor.`, { label })
      return deserializeResponse(descriptor.value)
    }

    if (descriptor.tag === 'object') {
      if (!Array.isArray(descriptor.entries) || !descriptor.entries.every(entry => Array.isArray(entry) && entry.length === 2 && hasRuntimeType(entry[0], 'string')))
        throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })
      const entries: Array<[string, unknown]> = []
      for (const [key, item] of descriptor.entries) entries.push([key, await decode(item, depth + 1)])
      return Object.fromEntries(entries)
    }

    if (descriptor.tag !== 'binary'
      || !Number.isSafeInteger(descriptor.id)
      || Object.is(descriptor.id, -0)
      // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- Number.isSafeInteger above establishes the numeric descriptor invariant.
      || (descriptor.id as number) < 0
      || (descriptor.kind !== 'blob' && descriptor.kind !== 'buffer' && descriptor.kind !== 'uint8array')
      || (descriptor.type !== undefined && !hasRuntimeType(descriptor.type, 'string'))) {
      throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })
  }

    if (state.sidecars >= limits.maxSidecars)
      throw transferLimitError(label, 'maxSidecars', state.sidecars + 1, limits.maxSidecars)
    const bytes = await readSidecar(`${assetsDir}/${descriptor.id}`)
    if (!bytes) {
      throw serializationError(`Sandbox ${label} binary sidecar ${descriptor.id} does not exist.`, {
        id: descriptor.id,
        label,
      })
    }
    if (state.sidecarBytes + bytes.byteLength > limits.maxSidecarBytes)
      throw transferLimitError(label, 'maxSidecarBytes', state.sidecarBytes + bytes.byteLength, limits.maxSidecarBytes)
    state.sidecars++
    state.sidecarBytes += bytes.byteLength
    return descriptor.kind === 'blob'
      ? new Blob([bytes], { type: descriptor.type === undefined ? '' : String(descriptor.type) })
      : descriptor.kind === 'buffer'
        ? Buffer.from(bytes)
        : bytes
  }

  return await decode(value, 0)
}
