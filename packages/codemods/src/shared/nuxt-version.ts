import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { intersects, validRange } from "semver"

import { codemodError, codemodsErrorDiagnostics } from "../error-diagnostics.ts"
import { readDependencies } from "./detect.ts"

import type { FileEdit } from "../types.ts"

export const nuxtNightlyRange = "npm:nuxt-nightly@5x"

const sections = ["dependencies", "devDependencies"] as const

async function readPnpmCatalogVersion(cwd: string, name: string, catalog: string): Promise<string | undefined> {
  let directory = cwd
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    if (dirname(directory) === directory) return
    directory = dirname(directory)
  }
  const code = await readFile(join(directory, "pnpm-workspace.yaml"), "utf8")
  let section: string | undefined
  let current: string | undefined
  let catalogIndent: number | undefined
  for (const line of code.split(/\r?\n/)) {
    const entry = /^( *)(["']?)([^"'#:]+?)\2[ \t]*:(?:[ \t]+(.*))?$/.exec(line)
    if (!entry) continue
    const [, indent = "", , key = ""] = entry
    const value = entry[4]?.replace(/(?:^|[ \t]+)#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2")
    if (!indent) {
      section = key
      current = section === "catalog" ? "default" : undefined
      catalogIndent = undefined
      continue
    }
    if (section === "catalogs" && (catalogIndent === undefined || indent.length <= catalogIndent)) {
      catalogIndent = indent.length
      current = key
      continue
    }
    if (current === catalog && key === name && value) return value
  }
}

async function findOldNuxt(cwd: string): Promise<{ nuxt: string, source: string } | undefined> {
  const nuxt = (await readDependencies(cwd)).get("nuxt")
  if (!nuxt) return
  const catalog = /^catalog:(.*)$/.exec(nuxt)?.[1]
  const version = catalog === undefined ? nuxt : await readPnpmCatalogVersion(cwd, "nuxt", catalog.trim() || "default")
  if (!version) return
  const options = { includePrerelease: true }
  const range = validRange(version.replace(/^npm:nuxt(?:-nightly)?@/, ""), options)
  if (!range || intersects(range, ">=5.0.0-0", options)) return
  return { nuxt, source: version === nuxt ? "" : `, which pnpm-workspace.yaml sets to "${version}"` }
}

/** Sets `nuxt` to Nuxt 5 nightly in each package.json section that lists it. */
export function setNuxtNightly(packageJson: string): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(packageJson)
  }
  catch (error) {
    throw codemodError(`Cannot parse package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const section of sections) {
    const dependencies: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, section) : undefined
    if (typeof dependencies === "object" && dependencies !== null && "nuxt" in dependencies) Reflect.set(dependencies, "nuxt", nuxtNightlyRange)
  }
  const indent = /^[ \t]+/m.exec(packageJson)?.[0] ?? "  "
  return `${JSON.stringify(manifest, null, indent)}${packageJson.endsWith("\n") ? "\n" : ""}`
}

export interface NuxtUpgrade {
  /** The package.json edit that sets Nuxt 5 nightly. */
  edit: FileEdit & { before: string, after: string }
  note: string
}

/**
 * Checks that the app runs Nuxt 5 before a codemod adds `vite-hub/nuxt`. On an older Nuxt it throws
 * `CODEMODS_NUXT_UNSUPPORTED`, or, with `nuxtNightly`, plans the package.json edit that moves the app to Nuxt 5 nightly.
 */
export async function planNuxtUpgrade(cwd: string, codemods: readonly string[], nuxtNightly: boolean): Promise<NuxtUpgrade | undefined> {
  const old = await findOldNuxt(cwd)
  if (!old) return
  if (!nuxtNightly) throw codemodsErrorDiagnostics.CODEMODS_NUXT_UNSUPPORTED({ codemods, ...old })
  const before = await readFile(join(cwd, "package.json"), "utf8")
  return {
    edit: { path: "package.json", before, after: setNuxtNightly(before) },
    note: `package.json now requires nuxt "${nuxtNightlyRange}" in place of "${old.nuxt}", because vite-hub/nuxt needs Nuxt 5. Nuxt 5 stops auto-importing Nitro helpers such as defineEventHandler in server code. Set experimental: { nitroAutoImports: true } to keep them while you migrate, or import them as the Nuxt 5 build error lists.`,
  }
}
