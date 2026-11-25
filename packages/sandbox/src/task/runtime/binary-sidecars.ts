import { deserializeResponse, isSerializedResponse } from '@vite-hub/runtime/internal/response'
import { isSandboxTaskError, sandboxTaskError } from '../sandbox-task/errors'
import type { TaskSandbox } from './task-sandbox'

export const SANDBOX_VALUE_MARKER = 'vitehub:sandbox-task:value'

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

const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get

const blobSizeGetter = typeof Blob === 'undefined'
  ? undefined
  : Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get
const blobArrayBuffer = typeof Blob === 'undefined' ? undefined : Blob.prototype.arrayBuffer

function readBlobSize(blob: Blob): number {
  return blobSizeGetter ? Reflect.apply(blobSizeGetter, blob, []) : blob.size
}

async function readBlobBytes(blob: Blob) {
  return new Uint8Array(await (blobArrayBuffer ? Reflect.apply(blobArrayBuffer, blob, []) : blob.arrayBuffer()))
}

function isUint8Array(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || !typedArrayTag) return false
  try { return typedArrayTag.call(value) === 'Uint8Array' }
  catch { return false }
}

function unboxJsonPrimitive(value: unknown): { value: unknown } | undefined {
  for (const unbox of [Boolean.prototype.valueOf, Number.prototype.valueOf, String.prototype.valueOf, BigInt.prototype.valueOf]) {
    try { Reflect.apply(unbox, value, []) }
    catch { continue }
    return { value: Reflect.apply((value as { valueOf: unknown }).valueOf as (...args: []) => unknown, value, []) }
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
  return sandboxTaskError(message, {
    code: 'SANDBOX_TASK_SERIALIZATION_ERROR',
    cause,
    details,
  })
}

/** The limits on one value that crosses the Sandbox boundary: its nesting depth and its binary sidecar files. */
export interface SandboxTaskTransferLimits {
  maxDepth: number
  maxSidecars: number
  maxSidecarBytes: number
}

export const DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS: SandboxTaskTransferLimits = {
  maxDepth: 32,
  maxSidecars: 64,
  maxSidecarBytes: 64 * 1024 * 1024,
}

export const DEFAULT_SANDBOX_TASK_TRANSFER_BYTES = 4 * 1024 * 1024

function transferLimitError(label: string, limit: string, value: number, maximum: number) {
  return sandboxTaskError(`Sandbox ${label} exceeds its ${limit} limit (${value} > ${maximum}).`, {
    code: 'SANDBOX_TASK_TRANSFER_LIMIT',
    details: { label, limit, value, maximum },
  })
}

export function isSandboxTaskTransferLimitError(error: unknown) {
  return isSandboxTaskError(error) && error.code === 'SANDBOX_TASK_TRANSFER_LIMIT'
}

/** Rejects a JSON envelope whose UTF-8 size is above `maximum` bytes. */
export function assertSandboxTaskTransferBytes(json: string, label: string, limit: 'maxInputBytes' | 'maxOutputBytes' | 'maxDiagnosticBytes', maximum: number) {
  const bytes = new TextEncoder().encode(json).byteLength
  if (bytes > maximum)
    throw transferLimitError(label, limit, bytes, maximum)
}

/** Encodes a value and holds its binary sidecars in memory. `writeSidecars()` writes them to the Sandbox. */
export async function encodeSandboxTaskValueStaged(
  sandbox: TaskSandbox,
  value: unknown,
  assetsDir: string,
  label: string,
  signal?: AbortSignal,
  limits: SandboxTaskTransferLimits = DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS,
  rootDepth = 0,
) {
  const state: { nextId: number, sidecarBytes: number, pendingWrites: Array<{ id: number, bytes: Uint8Array }> } = { nextId: 0, sidecarBytes: 0, pendingWrites: [] }
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

  async function stage(descriptor: Pick<BinaryDescriptor, 'kind' | 'type'>, byteLength: number, read: () => Uint8Array | Promise<Uint8Array>) {
    throwIfAborted()
    if (state.nextId + 1 > limits.maxSidecars)
      throw transferLimitError(label, 'maxSidecars', state.nextId + 1, limits.maxSidecars)
    if (state.sidecarBytes + byteLength > limits.maxSidecarBytes)
      throw transferLimitError(label, 'maxSidecarBytes', state.sidecarBytes + byteLength, limits.maxSidecarBytes)
    const bytes = await read()
    throwIfAborted()
    const sidecarBytes = state.sidecarBytes + bytes.byteLength
    if (sidecarBytes > limits.maxSidecarBytes)
      throw transferLimitError(label, 'maxSidecarBytes', sidecarBytes, limits.maxSidecarBytes)
    state.sidecarBytes = sidecarBytes
    const id = state.nextId++
    state.pendingWrites.push({ id, bytes })
    return tagged({ id, ...descriptor, tag: 'binary' })
  }

  async function encode(entry: unknown, ancestors: ReadonlySet<object>, key = '', applyToJSON = true, depth = 0): Promise<unknown> {
    if (typeof Blob !== 'undefined' && entry instanceof Blob) {
      const prototype = Object.getPrototypeOf(entry)
      if (prototype !== Blob.prototype && (typeof File === 'undefined' || prototype !== File.prototype))
        throw serializationError(`Sandbox ${label} Blob subclasses are not supported.`, { label })
      if (Object.hasOwn(entry, 'arrayBuffer'))
        throw serializationError(`Sandbox ${label} Blob arrayBuffer overrides are not supported.`, { label })
      return await stage({ kind: 'blob', ...(entry.type ? { type: entry.type } : {}) }, readBlobSize(entry), () => readBlobBytes(entry))
    }
    if (isUint8Array(entry)) {
      const buffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(entry)
      return await stage({ kind: buffer ? 'buffer' : 'uint8array' }, entry.byteLength, () => entry)
    }

    if (isObjectRecord(entry) && applyToJSON) {
      try {
        const toJSON = entry.toJSON
        if (typeof toJSON === 'function') {
          const replacement: unknown = Reflect.apply(toJSON, entry, [key])
          return await encode(replacement, ancestors, key, false, depth)
        }
      }
      catch (error) {
        if (isSandboxTaskError(error)) throw error
        throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label }, error)
      }
    }

    if (Array.isArray(entry)) {
      if (depth >= limits.maxDepth)
        throw transferLimitError(label, 'maxDepth', depth + 1, limits.maxDepth)
      if (ancestors.has(entry))
        throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label })
      const nextAncestors = new Set(ancestors).add(entry)
      const items: unknown[] = []
      for (const [index, item] of entry.entries())
        items.push(await encode(item, nextAncestors, String(index), true, depth + 1))
      return items
    }

    if (!isObjectRecord(entry)) return entry
    let boxed: { value: unknown } | undefined
    try {
      boxed = unboxJsonPrimitive(entry)
    }
    catch (error) {
      throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label }, error)
    }
    if (boxed) return await encode(boxed.value, ancestors, key, false, depth)
    if (depth >= limits.maxDepth)
      throw transferLimitError(label, 'maxDepth', depth + 1, limits.maxDepth)
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

  const encoded = await encode(value, new Set(), '', true, rootDepth)
  return {
    value: encoded,
    async writeSidecars() {
      if (!state.pendingWrites.length) return
      await abortable(sandbox.files.mkdir(assetsDir, { recursive: true, signal }))
      await Promise.all(state.pendingWrites.map(({ id, bytes }) => abortable(sandbox.files.write(`${assetsDir}/${id}`, bytes, { signal }))))
    },
  }
}

/** Encodes a value and writes its binary sidecars to the Sandbox. */
export async function encodeSandboxTaskValue(
  sandbox: TaskSandbox,
  value: unknown,
  assetsDir: string,
  label: string,
  signal?: AbortSignal,
  limits: SandboxTaskTransferLimits = DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS,
) {
  const encoded = await encodeSandboxTaskValueStaged(sandbox, value, assetsDir, label, signal, limits)
  await encoded.writeSidecars()
  return encoded.value
}

export async function decodeSandboxTaskValue(
  sandbox: TaskSandbox,
  value: unknown,
  assetsDir: string,
  label: string,
  signal?: AbortSignal,
  limits: SandboxTaskTransferLimits = DEFAULT_SANDBOX_TASK_TRANSFER_LIMITS,
): Promise<unknown> {
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
    const assertContainerDepth = () => {
      if (depth >= limits.maxDepth)
        throw transferLimitError(label, 'maxDepth', depth + 1, limits.maxDepth)
    }
    if (Array.isArray(entry)) {
      assertContainerDepth()
      const items: unknown[] = []
      for (const item of entry)
        items.push(await decode(item, depth + 1))
      return items
    }
    if (!isPlainObject(entry)) return entry

    if (!hasMarker(entry)) {
      assertContainerDepth()
      const entries: Array<[string, unknown]> = []
      for (const [key, item] of Object.entries(entry))
        entries.push([key, await decode(item, depth + 1)])
      return Object.fromEntries(entries)
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
      assertContainerDepth()
      if (!Array.isArray(descriptor.entries) || !descriptor.entries.every(item => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string'))
        throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })
      const entries: Array<[string, unknown]> = []
      for (const [key, item] of descriptor.entries)
        entries.push([key, await decode(item, depth + 1)])
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

    if (state.sidecars + 1 > limits.maxSidecars)
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
      ? new Blob([bytes], { type: descriptor.type || '' })
      : descriptor.kind === 'buffer'
        ? Buffer.from(bytes)
        : bytes
  }

  return await decode(value, 0)
}
