import { readFile, rm, writeFile } from "node:fs/promises"

export interface ProviderOutputConfigOwnership {
  arrays?: Record<string, { key: string, values?: unknown[] }>
  keys?: string[]
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return isJsonObject(parsed) ? parsed : {}
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

function deleteOwnedKeys(value: Record<string, unknown>, ownership: ProviderOutputConfigOwnership): Record<string, unknown> {
  const next = { ...value }
  for (const key of ownership.keys ?? []) delete next[key]
  for (const field of Object.keys(ownership.arrays ?? {})) delete next[field]
  return next
}

function mergeOwnedArrays(
  existing: Record<string, unknown>,
  value: Record<string, unknown>,
  arrays: ProviderOutputConfigOwnership["arrays"],
): Record<string, unknown> {
  const next = { ...value }
  for (const [field, ownership] of Object.entries(arrays ?? {})) {
    const current = Array.isArray(existing[field]) ? existing[field] : []
    const incoming = Array.isArray(value[field]) ? value[field] : []
    const incomingKeys = new Set(incoming.flatMap(item => isJsonObject(item) && item[ownership.key] !== undefined ? [item[ownership.key]] : []))
    const ownedKeys = new Set([...(ownership.values ?? []), ...incomingKeys])
    const merged = [
      ...current.filter(item => !isJsonObject(item) || !ownedKeys.has(item[ownership.key])),
      ...incoming,
    ]
    if (merged.length) next[field] = merged
    else delete next[field]
  }
  return next
}

export async function writeProviderOutputConfig(
  file: string,
  value: object,
  ownership: ProviderOutputConfigOwnership = {},
  options: { removeIfEmpty?: boolean } = {},
): Promise<void> {
  const existing = await readJsonObject(file) ?? {}
  const next = {
    ...deleteOwnedKeys(existing, ownership),
    ...mergeOwnedArrays(existing, value as Record<string, unknown>, ownership.arrays),
  }
  if (options.removeIfEmpty && !Object.keys(next).length) {
    await rm(file, { force: true })
    return
  }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

export async function cleanProviderOutputConfig(file: string, ownership: ProviderOutputConfigOwnership): Promise<void> {
  if (!ownership.keys?.length && !Object.keys(ownership.arrays ?? {}).length) return
  const existing = await readJsonObject(file)
  if (!existing) return

  const next = deleteOwnedKeys(existing, ownership)
  let changed = (ownership.keys ?? []).some(key => key in existing)
  for (const [field, arrayOwnership] of Object.entries(ownership.arrays ?? {})) {
    const current = Array.isArray(existing[field]) ? existing[field] : []
    const ownedKeys = new Set(arrayOwnership.values ?? [])
    const preserved = current.filter(item => !isJsonObject(item) || !ownedKeys.has(item[arrayOwnership.key]))
    if (preserved.length === current.length) {
      if (current.length) next[field] = current
      continue
    }
    changed = true
    if (preserved.length) next[field] = preserved
  }
  if (!changed) return
  if (!Object.keys(next).length) {
    await rm(file, { force: true })
    return
  }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}
