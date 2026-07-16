import { readFile, rm, writeFile } from "node:fs/promises"

export type ProviderJsonPrimitive = boolean | null | number | string
export type ProviderJsonRecord = Record<string, unknown>

export interface ProviderOutputConfigOwnership {
  arrays?: Record<string, { key: string, values?: ProviderJsonPrimitive[] }>
  keys?: string[]
}

function isProviderJsonRecord(value: unknown): value is ProviderJsonRecord {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(entry => entry === undefined || isProviderJsonValue(entry))
}

function isProviderJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isProviderJsonValue)
  return isProviderJsonRecord(value)
}

function assertProviderJsonRecord(value: unknown): asserts value is ProviderJsonRecord {
  if (!isProviderJsonRecord(value)) {
    throw new TypeError("[vitehub] Provider output config must be a JSON object.")
  }
}

async function readProviderJsonRecord(file: string): Promise<ProviderJsonRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    assertProviderJsonRecord(parsed)
    return parsed
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

function deleteOwnedFields(value: ProviderJsonRecord, ownership: ProviderOutputConfigOwnership): ProviderJsonRecord {
  const next = { ...value }
  for (const key of ownership.keys ?? []) delete next[key]
  for (const field of Object.keys(ownership.arrays ?? {})) delete next[field]
  return next
}

function getKeyedArrayEntryValue(value: unknown, key: string): ProviderJsonPrimitive | undefined {
  if (!isProviderJsonRecord(value)) return
  const entryValue = value[key]
  return entryValue === null || typeof entryValue === "boolean" || typeof entryValue === "number" || typeof entryValue === "string"
    ? entryValue
    : undefined
}

function preserveUnownedKeyedArrayEntries(
  value: unknown,
  ownership: NonNullable<ProviderOutputConfigOwnership["arrays"]>[string],
  replacements: unknown[] = [],
): unknown[] {
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
  value: ProviderJsonRecord,
  ownership: ProviderOutputConfigOwnership = {},
  options: { removeIfEmpty?: boolean } = {},
): Promise<void> {
  assertProviderJsonRecord(value)
  const existing = await readProviderJsonRecord(file) ?? {}
  const next = {
    ...deleteOwnedFields(existing, ownership),
    ...mergeOwnedArrays(existing, value, ownership.arrays),
  }
  await persistProviderJsonRecord(file, next, options.removeIfEmpty === true)
}

export async function cleanProviderOutputConfig(file: string, ownership: ProviderOutputConfigOwnership): Promise<void> {
  if (!ownership.keys?.length && !Object.keys(ownership.arrays ?? {}).length) return
  const existing = await readProviderJsonRecord(file)
  if (!existing) return

  const next = deleteOwnedFields(existing, ownership)
  let changed = (ownership.keys ?? []).some(key => key in existing)
  for (const [field, arrayOwnership] of Object.entries(ownership.arrays ?? {})) {
    if (!(field in existing)) continue
    const current = existing[field]
    const preserved = preserveUnownedKeyedArrayEntries(current, arrayOwnership)
    changed ||= !Array.isArray(current) || preserved.length !== current.length || preserved.length === 0
    if (preserved.length) next[field] = preserved
  }
  if (!changed) return
  await persistProviderJsonRecord(file, next, true)
}
