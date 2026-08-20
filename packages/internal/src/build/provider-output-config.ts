import { readFile, rm, writeFile } from "node:fs/promises"

type ProviderJsonPrimitive = boolean | null | number | string
type ProviderJsonValue = ProviderJsonPrimitive | ProviderJsonRecord | ProviderJsonValue[]

interface ProviderJsonRecord {
  [key: string]: ProviderJsonValue
}

export interface ProviderOutputConfigOwnership {
  arrays?: Record<string, { key?: string, preserveOnCleanup?: boolean, values?: ProviderJsonPrimitive[] }>
  keys?: string[]
}

function isProviderJsonArray(value: unknown[], ancestors: Set<object>): value is ProviderJsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) return false
  if (Reflect.ownKeys(value).length !== value.length + 1) return false

  ancestors.add(value)
  try {
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor) || !isProviderJsonValue(descriptor.value, ancestors)) return false
    }
    return true
  }
  finally {
    ancestors.delete(value)
  }
}

function isProviderJsonRecordValue(value: object, ancestors: Set<object>): value is ProviderJsonRecord {
  const prototype = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) return false

  ancestors.add(value)
  try {
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor?.enumerable === true
        && "value" in descriptor
        && isProviderJsonValue(descriptor.value, ancestors)
    })
  }
  finally {
    ancestors.delete(value)
  }
}

function isProviderJsonValue(value: unknown, ancestors: Set<object>): value is ProviderJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return isProviderJsonArray(value, ancestors)
  return typeof value === "object" && isProviderJsonRecordValue(value, ancestors)
}

function isProviderJsonRecord(value: unknown): value is ProviderJsonRecord {
  try {
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && isProviderJsonRecordValue(value, new Set())
  }
  catch {
    return false
  }
}

function assertProviderJsonRecord(value: unknown): asserts value is ProviderJsonRecord {
  if (!isProviderJsonRecord(value)) {
    throw new TypeError("[vitehub] Provider output config must be a JSON object.")
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function readProviderJsonRecord(file: string): Promise<ProviderJsonRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    assertProviderJsonRecord(parsed)
    return parsed
  }
  catch (error) {
    if (isFileNotFoundError(error)) return
    throw error
  }
}

function deleteOwnedFields(
  value: ProviderJsonRecord,
  ownership: ProviderOutputConfigOwnership,
  cleanup = false,
): ProviderJsonRecord {
  const next = { ...value }
  for (const key of ownership.keys ?? []) delete next[key]
  for (const [field, arrayOwnership] of Object.entries(ownership.arrays ?? {})) {
    if (!cleanup || !arrayOwnership.preserveOnCleanup) delete next[field]
  }
  return next
}

function getKeyedArrayEntryValue(value: unknown, key: string | undefined): ProviderJsonPrimitive | undefined {
  if (key === undefined) {
    return value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string"
      ? value
      : undefined
  }
  if (!isProviderJsonRecord(value)) return
  const entryValue = value[key]
  return entryValue === null || typeof entryValue === "boolean" || typeof entryValue === "number" || typeof entryValue === "string"
    ? entryValue
    : undefined
}

function preserveUnownedKeyedArrayEntries(
  value: ProviderJsonValue | undefined,
  ownership: NonNullable<ProviderOutputConfigOwnership["arrays"]>[string],
  replacements: ProviderJsonValue[] = [],
): ProviderJsonValue[] {
  const current = Array.isArray(value) ? value : []
  const replacementKeys = replacements.flatMap((entry) => {
    const key = getKeyedArrayEntryValue(entry, ownership.key)
    return key === undefined ? [] : [key]
  })
  const ownedKeys = new Set([...(ownership.values ?? []), ...replacementKeys])
  return current.filter((entry) => {
    const key = getKeyedArrayEntryValue(entry, ownership.key)
    return key === undefined || !ownedKeys.has(key)
  })
}

function mergeOwnedArrays(
  existing: ProviderJsonRecord,
  value: ProviderJsonRecord,
  arrays: ProviderOutputConfigOwnership["arrays"],
): ProviderJsonRecord {
  const next = { ...value }
  for (const [field, ownership] of Object.entries(arrays ?? {})) {
    const incoming = Array.isArray(value[field]) ? value[field] : []
    const merged = [
      ...preserveUnownedKeyedArrayEntries(existing[field], ownership, incoming),
      ...incoming,
    ]
    if (merged.length) next[field] = merged
    else delete next[field]
  }
  return next
}

async function persistProviderJsonRecord(file: string, value: ProviderJsonRecord, removeIfEmpty: boolean): Promise<void> {
  if (removeIfEmpty && !Object.keys(value).length) {
    await rm(file, { force: true })
    return
  }
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export async function writeProviderOutputConfig(
  file: string,
  value: unknown,
  ownership: ProviderOutputConfigOwnership = {},
  options: { defaults?: unknown, removeIfEmpty?: boolean } = {},
): Promise<void> {
  const existing = await readProviderJsonRecord(file) ?? {}
  const defaults = options.defaults ?? {}
  assertProviderJsonRecord(defaults)
  const next = mergeProviderOutputConfig({ ...defaults, ...existing }, value, ownership)
  await persistProviderJsonRecord(file, next, options.removeIfEmpty === true)
}

export function mergeProviderOutputConfig(
  existing: unknown,
  value: unknown,
  ownership: ProviderOutputConfigOwnership = {},
): ProviderJsonRecord {
  assertProviderJsonRecord(existing)
  assertProviderJsonRecord(value)
  return {
    ...deleteOwnedFields(existing, ownership),
    ...mergeOwnedArrays(existing, value, ownership.arrays),
  }
}

export function stringifyProviderOutputConfig(value: unknown): string {
  assertProviderJsonRecord(value)
  return JSON.stringify(value, null, 2)
}

export async function cleanProviderOutputConfig(file: string, ownership: ProviderOutputConfigOwnership): Promise<void> {
  if (!ownership.keys?.length && !Object.keys(ownership.arrays ?? {}).length) return
  const existing = await readProviderJsonRecord(file)
  if (!existing) return

  const next = deleteOwnedFields(existing, ownership, true)
  let changed = (ownership.keys ?? []).some(key => key in existing)
  for (const [field, arrayOwnership] of Object.entries(ownership.arrays ?? {})) {
    if (arrayOwnership.preserveOnCleanup) continue
    if (!(field in existing)) continue
    const current = existing[field]
    const preserved = preserveUnownedKeyedArrayEntries(current, arrayOwnership)
    changed ||= !Array.isArray(current) || preserved.length !== current.length || preserved.length === 0
    if (preserved.length) next[field] = preserved
  }
  if (!changed) return
  await persistProviderJsonRecord(file, next, true)
}
