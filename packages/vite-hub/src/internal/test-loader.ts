import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { LoadHook, ResolveHook } from "node:module"

/**
 * The module hooks of `vite-hub/test/register`. They ask the app's Vite server for the modules that `vitehub()`
 * generates, and for app imports that Node cannot resolve. Node resolves and loads every other module itself.
 */

/** The module that runs the test setup files of the ViteHub plugins, such as the Queue and Workflow registries. */
const setupSpecifier = "vitehub-test:setup"
const virtualScheme = "vitehub-test-virtual:"

let server = ""

export function initialize(data: { server: string }): void {
  server = data.server
}

async function ask<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
  const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const response = await fetch(`${server}/${path}?${params}`)
  if (!response.ok) throw new Error(`[vitehub] The Vite server of vite-hub/test failed:\n${await response.text()}`)
  return await response.json() as T
}

/** The id that Vite knows a module by: a file path, or the id of a virtual module. */
function importerId(parentURL: string | undefined): string | undefined {
  if (parentURL?.startsWith(virtualScheme)) return decodeURIComponent(parentURL.slice(virtualScheme.length))
  return parentURL?.startsWith("file:") ? fileURLToPath(parentURL) : undefined
}

async function resolveWithVite(specifier: string, parentURL: string | undefined) {
  const id = await ask<string | null>("resolve", { importer: importerId(parentURL), specifier })
  if (id === null) return undefined
  const file = isAbsolute(id) && existsSync(id.split("?")[0]!)
  return { shortCircuit: true, url: file ? pathToFileURL(id).href : `${virtualScheme}${encodeURIComponent(id)}` }
}

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  if (specifier === setupSpecifier) return { shortCircuit: true, url: setupSpecifier }
  // A ViteHub package imports the modules that `vitehub()` generates, such as `#vitehub/database/databases`.
  // A generated module imports packages from the app root. Vite gives `cloudflare:workers` a stub that Node can load.
  if (specifier.startsWith("#vitehub/") || specifier.startsWith("cloudflare:") || context.parentURL?.startsWith(virtualScheme)) {
    const resolved = await resolveWithVite(specifier, context.parentURL)
    if (resolved) return resolved
  }
  try {
    return await nextResolve(specifier, context)
  }
  catch (error) {
    // App code imports without extensions and through aliases, as Vite and Nitro resolve them.
    const parent = importerId(context.parentURL)
    if (!parent || parent.includes("/node_modules/")) throw error
    const resolved = await resolveWithVite(specifier, context.parentURL)
    if (resolved) return resolved
    throw error
  }
}

export const load: LoadHook = async (url, context, nextLoad) => {
  if (url === setupSpecifier) {
    const files = await ask<string[]>("setup")
    return { format: "module", shortCircuit: true, source: files.map(file => `import ${JSON.stringify(file)}\n`).join("") }
  }
  if (!url.startsWith(virtualScheme)) return await nextLoad(url, context)
  const id = decodeURIComponent(url.slice(virtualScheme.length))
  const source = await ask<string | null>("load", { id })
  if (source === null) throw new Error(`[vitehub] Vite resolved "${id}", but no plugin loads it.`)
  return { format: "module", shortCircuit: true, source }
}
