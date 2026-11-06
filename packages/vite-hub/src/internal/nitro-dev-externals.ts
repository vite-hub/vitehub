import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { isPlainObject as isRecord } from "@vite-hub/internal/object"

/**
 * Ids that only the Nitro bundle resolves: `#` imports and Nitro aliases, virtual modules, the Nitro runtime, and H3.
 * Nuxt 4 aliases `h3` to H3 1, and ViteHub bundles its own H3 2 for ViteHub importers, so Node would load another copy.
 */
export function nitroOnlyId(aliases: readonly string[]): (id: string) => boolean {
  const prefixes = aliases.map(alias => alias.endsWith("/") ? alias : `${alias}/`)
  const exact = new Set(aliases)
  return id => /^(?:[#~\0]|@\/|virtual:|(?:h3|nitro|nitropack)(?:\/|$))/.test(id) || exact.has(id) || prefixes.some(prefix => id.startsWith(prefix))
}

export const nitroDevInlineMatcherName = "vite-hub/nitro-dev-inline"

/** The `externals.inline` entry that bundles a ViteHub package. Nitro calls it with each import id and resolved path. */
export type NitroInlineMatcher = ((id: string) => boolean) & { readonly nodePackages: ReadonlySet<string> }

const importedId = /\b(?:from|import|require)\s*\(?\s*["']([^"'\s]+)["']/g

/**
 * Nitro 2 development bundles inline modules and leaves the others to Node. A ViteHub package must be inline when its
 * code imports an id that only the Nitro bundle resolves, or a package that must be inline. Node loads the others from
 * `node_modules`, so Rollup does not keep their code and sourcemaps across rebuilds.
 *
 * `nitroOnly` names the ids that only the bundle resolves. The result lists the packages that Node can load. A package
 * that this function cannot find, or that has no JavaScript to read, stays inline.
 */
export function nodeLoadableViteHubPackages(packageJsonPath: string, nitroOnly: (id: string) => boolean): Set<string> {
  const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  const queue = declaredViteHubPackages(manifest).map(name => ({ from: packageJsonPath, name }))
  const imports = new Map<string, Set<string>>()
  const inline = new Set(["vite-hub"])
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { from, name } = next
    if (imports.has(name) || inline.has(name)) continue
    const path = locatePackageJson(name, from)
    const packages = path && viteHubImports(path, name, nitroOnly)
    if (!path || !packages) {
      inline.add(name)
      continue
    }
    imports.set(name, packages)
    for (const dependency of packages) queue.push({ from: path, name: dependency })
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [name, packages] of imports) {
      if ([...packages].some(dependency => inline.has(dependency))) {
        inline.add(name)
        imports.delete(name)
        changed = true
      }
    }
  }
  return new Set(imports.keys())
}

/** An `externals.inline` matcher for `vite-hub` and every `@vite-hub/*` package except `nodePackages`. */
export function nitroDevInlineMatcher(nodePackages: ReadonlySet<string>): NitroInlineMatcher {
  const matcher = (id: string) => {
    const name = viteHubPackageName(id.replaceAll("\\", "/").split("node_modules/").pop()!)
    return name !== undefined && !nodePackages.has(name)
  }
  Object.defineProperty(matcher, "name", { value: nitroDevInlineMatcherName })
  return Object.assign(matcher, { nodePackages })
}

function declaredViteHubPackages(manifest: unknown): string[] {
  if (!isRecord(manifest)) return []
  const fields = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]
  return [...new Set(fields.flatMap(field => isRecord(field) ? Object.keys(field) : []).filter(name => name.startsWith("@vite-hub/")))]
}

function locatePackageJson(name: string, from: string): string | undefined {
  try {
    return findPackageJSON(name, pathToFileURL(from))
  }
  catch {
    return undefined // Not installed, or no entry that Node can resolve. Keep it inline.
  }
}

/**
 * Reads the published JavaScript of a package and returns the other ViteHub packages that it imports. Returns
 * `undefined` when the package must stay inline: it has no JavaScript, or it imports an id that only Nitro resolves.
 */
function viteHubImports(packageJsonPath: string, name: string, nitroOnly: (id: string) => boolean): Set<string> | undefined {
  const directory = dirname(packageJsonPath)
  const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  const files = isRecord(manifest) && Array.isArray(manifest.files) && manifest.files.every(file => typeof file === "string" && !file.includes("*"))
    ? manifest.files.map(file => join(directory, file)).filter(path => existsSync(path))
    : [directory]
  const scripts = files.flatMap(javascriptFiles)
  if (!scripts.length) return undefined
  const packages = new Set<string>()
  for (const path of scripts) {
    for (const [, id] of readFileSync(path, "utf8").matchAll(importedId)) {
      if (nitroOnly(id!)) return undefined
      const dependency = viteHubPackageName(id!)
      if (dependency && dependency !== name) packages.add(dependency)
    }
  }
  return packages
}

function javascriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return /\.[cm]?js$/.test(path) ? [path] : []
  return readdirSync(path).flatMap(name => name === "node_modules" ? [] : javascriptFiles(join(path, name)))
}

function viteHubPackageName(id: string): string | undefined {
  if (id === "vite-hub" || id.startsWith("vite-hub/")) return "vite-hub"
  const match = /^@vite-hub\/[^/]+/.exec(id)
  return match?.[0]
}
