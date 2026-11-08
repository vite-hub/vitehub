import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { findProperty } from "@vite-hub/internal/ast"

import { CodemodError } from "../types.ts"
import { findModuleEntry, readNuxtConfig } from "./nuxt-config.ts"

import type { Detection } from "../types.ts"

/** Names in `dependencies` and `devDependencies` of the project's package.json. */
export async function readDependencies(cwd: string): Promise<Map<string, string>> {
  const path = join(cwd, "package.json")
  if (!existsSync(path)) return new Map()
  try {
    const manifest: unknown = JSON.parse(await readFile(path, "utf8"))
    const entries: Array<[string, string]> = []
    for (const section of ["dependencies", "devDependencies"]) {
      const value = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, section) : undefined
      if (typeof value !== "object" || value === null) continue
      for (const [name, range] of Object.entries(value)) if (typeof range === "string") entries.push([name, range])
    }
    return new Map(entries)
  }
  catch {
    return new Map()
  }
}

/**
 * Detects a Nuxt module by its `modules` entry, by one of its root config keys, or by its package.json entry.
 * A nuxt.config that cannot be read counts as a match when package.json lists the module, so the codemod can
 * explain the problem.
 */
export async function detectNuxtModule(cwd: string, moduleName: string, configKeys: readonly string[] = []): Promise<Detection | undefined> {
  const dependencies = await readDependencies(cwd)
  try {
    const config = await readNuxtConfig(cwd)
    if (findModuleEntry(config, moduleName)) return { reason: `${config.fileName} lists ${moduleName} in modules` }
    const key = configKeys.find(name => findProperty(config.root, name))
    if (key) return { reason: `${config.fileName} sets ${key}` }
  }
  catch (error) {
    if (!(error instanceof CodemodError)) throw error
  }
  if (dependencies.has(moduleName)) return { reason: `package.json depends on ${moduleName}` }
  return undefined
}
