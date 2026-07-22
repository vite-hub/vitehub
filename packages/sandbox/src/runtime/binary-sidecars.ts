import { SandboxError } from '../sandbox/errors'
import type { SandboxExecutionBox } from './execution-box'

export const SANDBOX_VALUE_MARKER = 'vitehub:sandbox:value'

type BinaryDescriptor = {
  id: number
  kind: 'blob' | 'uint8array'
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

function serializationError(message: string, details?: Record<string, unknown>) {
  return new SandboxError(message, {
    code: 'SERIALIZATION_ERROR',
    details,
  })
}

export async function encodeSandboxValue(
  sandbox: SandboxExecutionBox,
  value: unknown,
  assetsDir: string,
  label: string,
) {
  const state: { directory?: Promise<void>, nextId: number } = { nextId: 0 }

  async function encode(entry: unknown, ancestors: ReadonlySet<object>, key = '', applyToJSON = true): Promise<unknown> {
    const blob = typeof Blob !== 'undefined' && entry instanceof Blob
    if (blob || entry instanceof Uint8Array) {
      const id = state.nextId++
      state.directory ||= sandbox.files.mkdir(assetsDir, { recursive: true })
      await state.directory
      const bytes = blob
        ? new Uint8Array(await (entry as Blob).arrayBuffer())
        : entry as Uint8Array
      await sandbox.files.write(`${assetsDir}/${id}`, bytes)
      return tagged({
        id,
        kind: blob ? 'blob' : 'uint8array',
        ...(blob && (entry as Blob).type ? { type: (entry as Blob).type } : {}),
        tag: 'binary',
      })
    }

    if (isObjectRecord(entry) && applyToJSON && typeof entry.toJSON === 'function')
      return await encode(Reflect.apply(entry.toJSON, entry, [key]), ancestors, key, false)

    if (Array.isArray(entry)) {
      if (ancestors.has(entry))
        throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label })
      const nextAncestors = new Set(ancestors).add(entry)
      return await Promise.all(entry.map((item, index) => encode(item, nextAncestors, String(index))))
    }

    if (!isObjectRecord(entry)) return entry
    if (isBoxedJsonPrimitive(entry)) return await encode(entry.valueOf(), ancestors, key, false)
    if (ancestors.has(entry))
      throw serializationError(`Sandbox ${label} must be JSON-serializable.`, { label })

    const nextAncestors = new Set(ancestors).add(entry)
    const sourceEntries = Object.entries(entry).filter(([entryKey, item]) => applyToJSON || entryKey !== 'toJSON' || typeof item !== 'function')
    const entries = await Promise.all(sourceEntries.map(async ([entryKey, item]) => [entryKey, await encode(item, nextAncestors, entryKey)] as [string, unknown]))
    return hasMarker(entry) ? tagged({ entries, tag: 'object' }) : Object.fromEntries(entries)
  }

  return await encode(value, new Set())
}

export async function decodeSandboxValue(
  sandbox: SandboxExecutionBox,
  value: unknown,
  assetsDir: string,
  label: string,
): Promise<unknown> {
  if (Array.isArray(value))
    return await Promise.all(value.map(entry => decodeSandboxValue(sandbox, entry, assetsDir, label)))
  if (!isPlainObject(value)) return value

  if (!hasMarker(value)) {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [
      key,
      await decodeSandboxValue(sandbox, entry, assetsDir, label),
    ])))
  }

  const descriptor = value[SANDBOX_VALUE_MARKER]
  if (!isPlainObject(descriptor) || typeof descriptor.tag !== 'string')
    throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })

  if (descriptor.tag === 'object') {
    if (!Array.isArray(descriptor.entries) || !descriptor.entries.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'))
      throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })
    return Object.fromEntries(await Promise.all(descriptor.entries.map(async ([key, entry]) => [
      key,
      await decodeSandboxValue(sandbox, entry, assetsDir, label),
    ])))
  }

  if (descriptor.tag !== 'binary'
    || !Number.isSafeInteger(descriptor.id)
    || Object.is(descriptor.id, -0)
    || (descriptor.id as number) < 0
    || (descriptor.kind !== 'blob' && descriptor.kind !== 'uint8array')
    || (typeof descriptor.type !== 'undefined' && typeof descriptor.type !== 'string')) {
    throw serializationError(`Sandbox ${label} contains an invalid binary sidecar descriptor.`, { label })
  }

  const bytes = await sandbox.files.read(`${assetsDir}/${descriptor.id}`)
  if (!bytes) {
    throw serializationError(`Sandbox ${label} binary sidecar ${descriptor.id} does not exist.`, {
      id: descriptor.id,
      label,
    })
  }
  return descriptor.kind === 'blob'
    ? new Blob([bytes], { type: descriptor.type || '' })
    : bytes
}
