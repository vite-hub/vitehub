import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { intersects, lt, minVersion, parse, Range, validRange } from "semver"
import { parseDocument } from "yaml"

import { codemodError, codemodsErrorDiagnostics } from "../error-diagnostics.ts"
import { readDependencies } from "./detect.ts"

export const nuxtNightlyRange = "npm:nuxt-nightly@5x"

/** The `nitro` range that `vite-hub` accepts. With `nitro` in package.json, Nuxt 4.7 builds the server with Nitro 3. */
export const nitroRange = "^3.0.261103-rc"

const firstNitro3Nuxt = "4.7.0"
const sections = ["dependencies", "devDependencies"] as const

type Manifest = Record<string, unknown>

function isRecord(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function catalogEntry(value: unknown, key: string): unknown {
  return value instanceof Map ? value.get(key) : undefined
}

async function readPnpmCatalogVersion(cwd: string, name: string, catalog: string): Promise<string | undefined> {
  let directory = cwd
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    if (dirname(directory) === directory) return
    directory = dirname(directory)
  }
  const document = parseDocument(await readFile(join(directory, "pnpm-workspace.yaml"), "utf8"))
  const workspace: unknown = document.toJS({ mapAsMap: true })
  const fallback = catalog === "default" ? catalogEntry(catalogEntry(workspace, "catalog"), name) : undefined
  const named = catalogEntry(catalogEntry(workspace, "catalogs"), catalog)
  const version = catalogEntry(named, name) ?? fallback
  if (typeof version === "string") return version
}

function admitsNuxt5(range: string): boolean {
  if (intersects(range, ">=5.0.0")) return true
  return new Range(range).set.some((comparators) => {
    const clause = comparators.map(comparator => comparator.value).join(" ")
    return comparators.some(({ value }) => {
      const version = parse(value.replace(/^[<>=]+/, ""))
      if (!version || version.major < 5 || !version.prerelease.length) return false
      const release = `${version.major}.${version.minor}.${version.patch}`
      return minVersion(`${clause} >=${release}-0 <${release}`) !== null
    })
  })
}

interface NuxtRange {
  nuxt: string
  source: string
  range: string
}

async function readNuxtRange(cwd: string): Promise<NuxtRange | undefined> {
  const nuxt = (await readDependencies(cwd)).get("nuxt")
  if (!nuxt) return
  const catalog = /^catalog:(.*)$/.exec(nuxt)?.[1]
  const version = catalog === undefined ? nuxt : await readPnpmCatalogVersion(cwd, "nuxt", catalog.trim() || "default")
  if (!version) return
  const range = validRange(version.replace(/^npm:nuxt(?:-nightly)?@/, ""))
  if (!range) return
  return { nuxt, range, source: version === nuxt ? "" : `, which pnpm-workspace.yaml sets to "${version}"` }
}

function allowsNitro2Nuxt(range: string): boolean {
  const lowest = minVersion(range)
  return !lowest || lt(lowest, firstNitro3Nuxt)
}

/** False when package.json requires a Nuxt version before 5, directly or through a pnpm `catalog:`. */
export async function allowsNuxt5(cwd: string): Promise<boolean> {
  const found = await readNuxtRange(cwd)
  return !found || admitsNuxt5(found.range)
}

function rewriteManifest(packageJson: string, change: (manifest: Manifest) => void): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(packageJson)
  }
  catch (error) {
    throw codemodError(`Cannot parse package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(manifest)) throw codemodError("package.json must contain an object.")
  change(manifest)
  const indent = /^[ \t]+/m.exec(packageJson)?.[0] ?? "  "
  return `${JSON.stringify(manifest, null, indent)}${packageJson.endsWith("\n") ? "\n" : ""}`
}

/** Sets `nuxt` to Nuxt 5 nightly in each package.json section that lists it. */
export function setNuxtNightly(packageJson: string): string {
  return rewriteManifest(packageJson, (manifest) => {
    for (const section of sections) {
      const dependencies = manifest[section]
      if (isRecord(dependencies) && "nuxt" in dependencies) dependencies.nuxt = nuxtNightlyRange
    }
  })
}

/** Adds `nitro` to `dependencies` when no section lists it. */
export function addNitro(packageJson: string): string {
  return rewriteManifest(packageJson, (manifest) => {
    if (sections.some((section) => {
      const dependencies = manifest[section]
      return isRecord(dependencies) && "nitro" in dependencies
    })) return
    const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
    manifest.dependencies = Object.fromEntries(Object.entries({ ...dependencies, nitro: nitroRange }).sort(([left], [right]) => left.localeCompare(right)))
  })
}

export interface Nitro3Plan {
  /** Changes package.json so that Nuxt builds the server with Nitro 3. */
  update: (packageJson: string) => string
  note: string
}

/**
 * Checks that the app builds its server with Nitro 3 before a codemod adds `vite-hub/nuxt`. On Nuxt 4.7 without
 * `nitro` in package.json, it plans to add `nitro`. On a Nuxt range that allows a version before 4.7, it throws
 * `CODEMODS_NUXT_UNSUPPORTED`, or, with `nuxtNightly`, plans to move the app to Nuxt 5 nightly.
 */
export async function planNitro3(cwd: string, codemods: readonly string[], nuxtNightly: boolean): Promise<Nitro3Plan | undefined> {
  const found = await readNuxtRange(cwd)
  if (!found || admitsNuxt5(found.range)) return
  if (!allowsNitro2Nuxt(found.range)) {
    if ((await readDependencies(cwd)).has("nitro")) return
    return {
      update: addNitro,
      note: `package.json now lists nitro "${nitroRange}" in dependencies. With it, Nuxt 4.7 builds the server with Nitro 3 and H3 2, which vite-hub/nuxt needs. Install it with the other packages.`,
    }
  }
  const { nuxt, source } = found
  if (!nuxtNightly) throw codemodsErrorDiagnostics.CODEMODS_NUXT_UNSUPPORTED({ codemods, nuxt, source })
  return {
    update: setNuxtNightly,
    note: `package.json now requires nuxt "${nuxtNightlyRange}" in place of "${nuxt}", because vite-hub/nuxt needs Nitro 3, and a Nuxt version before 4.7 runs Nitro 2. Nuxt 5 stops auto-importing Nitro helpers such as defineEventHandler in server code. Set experimental: { nitroAutoImports: true } to keep them while you migrate, or import them as the Nuxt 5 build error lists.`,
  }
}
