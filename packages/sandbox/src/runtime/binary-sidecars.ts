import { deserializeResponse, isSerializedResponse } from '@vite-hub/runtime'
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

function isBoxedJsonPrimitive(value: object) {
  return value instanceof Boolean
    || value instanceof Number
    || value instanceof String
    || Object.getPrototypeOf(value) === BigInt.prototype
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

export async function encodeSandboxValue(
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
    const buffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(entry)
    if (blob || entry instanceof Uint8Array) {
      throwIfAborted()
      if (state.nextId + 1 > limits.maxSidecars)
        throw transferLimitError(label, 'maxSidecars', state.nextId + 1, limits.maxSidecars)
      const id = state.nextId++
      const bytes = blob
        ? new Uint8Array(await (entry as Blob).arrayBuffer())
        : entry as Uint8Array
      throwIfAborted()
      if (state.sidecarBytes + bytes.byteLength > limits.maxSidecarBytes)
        throw transferLimitError(label, 'maxSidecarBytes', state.sidecarBytes + bytes.byteLength, limits.maxSidecarBytes)
      state.sidecarBytes += bytes.byteLength
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
        return await encode(Reflect.apply(entry.toJSON, entry, [key]), ancestors, key, false, depth)
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
      return await Promise.all(entry.map((item, index) => encode(item, nextAncestors, String(index), true, depth + 1)))
    }

    if (!isObjectRecord(entry)) return entry
    if (isBoxedJsonPrimitive(entry)) return await encode(entry.valueOf(), ancestors, key, false, depth)
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
    const entries = await Promise.all(sourceEntries.map(async ([entryKey, item]) => [entryKey, await encode(item, nextAncestors, entryKey, true, depth + 1)] as [string, unknown]))
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

export async function decodeSandboxValue(
  sandbox: SandboxExecutionBox,
  value: unknown,
  assetsDir: string,
  label: string,
  limits: SandboxTransferLimits = DEFAULT_SANDBOX_TRANSFER_LIMITS,
): Promise<unknown> {
  const state = { sidecars: 0, sidecarBytes: 0 }
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
    if (!isPlainObject(descriptor) || typeof descriptor.tag !== 'string')
      throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })

    if (descriptor.tag === 'response') {
      if (!isSerializedResponse(descriptor.value))
        throw serializationError(`Sandbox ${label} contains an invalid response descriptor.`, { label })
      return deserializeResponse(descriptor.value)
    }

    if (descriptor.tag === 'object') {
      if (!Array.isArray(descriptor.entries) || !descriptor.entries.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'))
        throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })
      const entries: Array<[string, unknown]> = []
      for (const [key, item] of descriptor.entries) entries.push([key, await decode(item, depth + 1)])
      return Object.fromEntries(entries)
    }

  if (descriptor.tag !== 'binary'
    || !Number.isSafeInteger(descriptor.id)
    || Object.is(descriptor.id, -0)
    || (descriptor.id as number) < 0
    || (descriptor.kind !== 'blob' && descriptor.kind !== 'buffer' && descriptor.kind !== 'uint8array')
    || (typeof descriptor.type !== 'undefined' && typeof descriptor.type !== 'string')) {
      throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })
  }

    if (state.sidecars >= limits.maxSidecars)
      throw transferLimitError(label, 'maxSidecars', state.sidecars + 1, limits.maxSidecars)
    const bytes = await sandbox.files.read(`${assetsDir}/${descriptor.id}`)
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
      ? new Blob([bytes], { type: descriptor.type || '' })
      : descriptor.kind === 'buffer'
        ? Buffer.from(bytes)
        : bytes
  }

  return await decode(value, 0)
}
