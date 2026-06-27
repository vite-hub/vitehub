import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { toSafeAppName } from "./user-entry.ts"

export const defaultCloudflareCompatibilityDate = "2026-04-20"

export interface CloudflareWranglerConfigOptions {
  outputRoot?: string
  rootDir: string
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

async function writeMergedJsonObject(file: string, value: object, ownedKeys?: string[]): Promise<void> {
  const existing = await readJsonObject(file)
  await writeFile(file, `${JSON.stringify({ ...deleteJsonObjectKeys(existing, ownedKeys), ...value }, null, 2)}\n`, "utf8")
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
    await deleteJsonObjectKeysFromFile(configFile, options.wranglerConfigKeys)
    return
  }

  await mkdir(outputRoot, { recursive: true })
  await writeMergedJsonObject(configFile, options.wranglerConfig, options.wranglerConfigKeys)
}
