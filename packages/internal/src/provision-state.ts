import { mkdir, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"

import { dirname, resolve } from "pathe"

import type { ProvisionState } from "./provision.ts"

export const PROVISION_STATE_FILE = ".vitehub/provision.json"

export function getProvisionStatePath(rootDir: string): string {
  return resolve(rootDir, PROVISION_STATE_FILE)
}

export async function readProvisionState(rootDir: string): Promise<ProvisionState> {
  try {
    return parseProvisionState(await readFile(getProvisionStatePath(rootDir), "utf8"))
  } catch {
    return {}
  }
}

export function readProvisionStateSync(rootDir: string): ProvisionState {
  try {
    return parseProvisionState(readFileSync(getProvisionStatePath(rootDir), "utf8"))
  } catch {
    return {}
  }
}

// Reads a single provisioned identifier, e.g. ("cloudflare", "d1", "primary").
export function readProvisionedId(state: ProvisionState, provider: keyof ProvisionState, category: string, key: string): string | undefined {
  return state[provider]?.[category]?.[key]
}

export async function writeProvisionState(rootDir: string, next: ProvisionState): Promise<void> {
  const path = getProvisionStatePath(rootDir)
  const merged = mergeProvisionState(await readProvisionState(rootDir), next)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(sortState(merged), null, 2)}\n`, "utf8")
}

export function mergeProvisionState(base: ProvisionState, next: ProvisionState): ProvisionState {
  const merged: ProvisionState = structuredClone(base)
  for (const provider of Object.keys(next) as Array<keyof ProvisionState>) {
    const categories = next[provider]
    if (!categories) continue
    const target = (merged[provider] ??= {})
    for (const [category, ids] of Object.entries(categories)) {
      target[category] = { ...target[category], ...ids }
    }
  }
  return merged
}

function parseProvisionState(raw: string): ProvisionState {
  const parsed: unknown = JSON.parse(raw)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ProvisionState) : {}
}

function sortState(state: ProvisionState): ProvisionState {
  return sortKeys(state) as ProvisionState
}

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]))
}
