import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { toSafeAppName } from "./user-entry.ts"

export const defaultCloudflareCompatibilityDate = "2026-04-20"

interface CloudflareWranglerConfigOptions {
  wranglerArrayOwnedValues?: Record<string, unknown[]>
  outputRoot?: string
  rootDir: string
  wranglerArrayMergeKeys?: Record<string, string>
  wranglerConfig?: object
  wranglerConfigKeys?: string[]
}

export function createDefaultCloudflareOutputRoot(rootDir: string): string {
  return resolve(rootDir, "dist", toSafeAppName(rootDir))
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return isJsonObject(parsed) ? parsed : {}
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
}

function deleteJsonObjectKeys(value: Record<string, unknown>, keys: string[] | undefined): Record<string, unknown> {
  if (!keys?.length) return value
  const next = { ...value }
  for (const key of keys) {
    delete next[key]
  }
  return next
}

function mergeJsonObjectArrays(
  existing: Record<string, unknown>,
  value: Record<string, unknown>,
  arrayMergeKeys: Record<string, string> | undefined,
  arrayOwnedValues: Record<string, unknown[]> | undefined,
): Record<string, unknown> {
  if (!arrayMergeKeys) return value
  const next = { ...value }
  for (const [field, key] of Object.entries(arrayMergeKeys)) {
    const current = existing[field]
    const incoming = value[field]
    const currentArray = Array.isArray(current) ? current : []
    const incomingArray = Array.isArray(incoming) ? incoming : []
    const ownedValues = new Set(arrayOwnedValues?.[field] ?? [])
    if (!currentArray.length && !incomingArray.length) continue

    const incomingKeys = new Set<unknown>()
    for (const item of incomingArray) {
      if (isJsonObject(item) && item[key] !== undefined) incomingKeys.add(item[key])
    }
    const removedKeys = new Set([...ownedValues, ...incomingKeys])
    const merged = [
      ...currentArray.filter(item => !isJsonObject(item) || !removedKeys.has(item[key])),
      ...incomingArray,
    ]
    if (!merged.length) {
      delete next[field]
      continue
    }
    next[field] = merged
  }
  return next
}

async function writeMergedJsonObject(
  file: string,
  value: object,
  ownedKeys?: string[],
  arrayMergeKeys?: Record<string, string>,
  arrayOwnedValues?: Record<string, unknown[]>,
): Promise<void> {
  const existing = await readJsonObject(file)
  const ownedTopLevelKeys = [...(ownedKeys ?? []), ...Object.keys(arrayMergeKeys ?? {})]
  const next = {
    ...deleteJsonObjectKeys(existing, ownedTopLevelKeys),
    ...mergeJsonObjectArrays(existing, value as Record<string, unknown>, arrayMergeKeys, arrayOwnedValues),
  }
  if (!Object.keys(next).length) {
    await rm(file, { force: true })
    return
  }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

async function deleteJsonObjectKeysFromFile(file: string, keys: string[] | undefined): Promise<void> {
  if (!keys?.length) return
  let existing: Record<string, unknown>
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    existing = isJsonObject(parsed) ? parsed : {}
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const next = { ...existing }
  let changed = false
  for (const key of keys) {
    if (key in next) {
      delete next[key]
      changed = true
    }
  }
  if (!changed) return
  if (!Object.keys(next).length) {
    await rm(file, { force: true })
    return
  }
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

export async function writeCloudflareWranglerConfig(options: CloudflareWranglerConfigOptions): Promise<void> {
  const outputRoot = options.outputRoot ?? createDefaultCloudflareOutputRoot(options.rootDir)
  const configFile = resolve(outputRoot, "wrangler.json")
  if (!options.wranglerConfig) {
    if (options.wranglerArrayOwnedValues && options.wranglerArrayMergeKeys) {
      await writeMergedJsonObject(configFile, {}, options.wranglerConfigKeys, options.wranglerArrayMergeKeys, options.wranglerArrayOwnedValues)
      return
    }
    await deleteJsonObjectKeysFromFile(configFile, options.wranglerConfigKeys)
    return
  }

  await mkdir(outputRoot, { recursive: true })
  await writeMergedJsonObject(
    configFile,
    options.wranglerConfig,
    options.wranglerConfigKeys,
    options.wranglerArrayMergeKeys,
    options.wranglerArrayOwnedValues,
  )
}
