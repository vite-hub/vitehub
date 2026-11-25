import { intersects, lt, minVersion, parse, Range, satisfies, subset, validRange } from "semver"

import { codemodError, codemodsErrorDiagnostics } from "../error-diagnostics.ts"
import { readDependencies } from "./detect.ts"
import { readPnpmCatalogVersion } from "./pnpm-catalog.ts"

export const nuxtNightlyRange = "npm:nuxt-nightly@5x"

/** The `nitro` range that `vite-hub` accepts. With `nitro` in package.json, Nuxt 4.7 builds the server with Nitro 3. */
export const nitroRange = "^3.0.261103-rc"

const firstNitro3Nuxt = "4.7.0"
const firstNuxt5 = "5.0.0-0"
const sections = ["dependencies", "devDependencies"] as const

type Manifest = Record<string, unknown>

function isRecord(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

async function resolveCatalog(cwd: string, name: string, value: string): Promise<string | undefined> {
  const catalog = /^catalog:(.*)$/.exec(value)?.[1]
  return catalog === undefined ? value : await readPnpmCatalogVersion(cwd, name, catalog.trim() || "default")
}

async function readNuxtRange(cwd: string): Promise<NuxtRange | undefined> {
  const nuxt = (await readDependencies(cwd)).get("nuxt")
  if (!nuxt) return
  const version = await resolveCatalog(cwd, "nuxt", nuxt)
  if (!version) return
  const range = validRange(version.replace(/^npm:nuxt(?:-nightly)?@/, ""))
  if (!range) return
  return { nuxt, range, source: version === nuxt ? "" : `, which pnpm-workspace.yaml sets to "${version}"` }
}

function fitsNitro3(version: string): boolean | undefined {
  const alias = /^npm:(@?[^@]+)@(.*)$/.exec(version)
  if (alias && alias[1] !== "nitro") return false
  const range = validRange(alias?.[2] ?? version)
  if (!range) return
  return range.split("||").every((clause) => {
    const exact = parse(clause.trim())
    return exact ? satisfies(exact, nitroRange) : subset(clause, nitroRange)
  })
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

/** Sets `nitro` to the range that Nuxt 4.7 builds with, in each section that lists it, or in `dependencies`. */
export function setNitro(packageJson: string): string {
  return rewriteManifest(packageJson, (manifest) => {
    let listed = false
    for (const section of sections) {
      const dependencies = manifest[section]
      if (!isRecord(dependencies) || !("nitro" in dependencies)) continue
      dependencies.nitro = nitroRange
      listed = true
    }
    if (listed) return
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
 * Checks that the app builds its server with Nitro 3 before a codemod adds `vite-hub/nuxt`. On a Nuxt range that allows a
 * version before 4.7, it throws `CODEMODS_NUXT_UNSUPPORTED`, or, with `nuxtNightly`, plans to move the app to Nuxt 5
 * nightly. On a range that allows Nuxt 4.7, it plans to add `nitro`, or to replace a `nitro` range that Nuxt 4.7 cannot
 * build with.
 */
export async function planNitro3(cwd: string, codemods: readonly string[], nuxtNightly: boolean): Promise<Nitro3Plan | undefined> {
  const found = await readNuxtRange(cwd)
  const lowest = found && minVersion(found.range)
  if (!found || !lowest || !lt(lowest, firstNuxt5)) return
  if (!lt(lowest, firstNitro3Nuxt)) {
    const declared = (await readDependencies(cwd)).get("nitro")
    if (declared === undefined) {
      return {
        update: setNitro,
        note: `package.json now lists nitro "${nitroRange}" in dependencies. With it, Nuxt 4.7 builds the server with Nitro 3 and H3 2, which vite-hub/nuxt needs. Install it with the other packages.`,
      }
    }
    const version = await resolveCatalog(cwd, "nitro", declared)
    if (version === undefined || fitsNitro3(version) !== false) return
    return {
      update: setNitro,
      note: `package.json listed nitro "${declared}"${version === declared ? "" : `, which pnpm-workspace.yaml sets to "${version}"`}, and Nuxt 4.7 builds the server only with nitro "${nitroRange}". package.json now lists nitro "${nitroRange}". Install it with the other packages.`,
    }
  }
  const { nuxt, source } = found
  if (!nuxtNightly) throw codemodsErrorDiagnostics.CODEMODS_NUXT_UNSUPPORTED({ codemods, nuxt, source })
  return {
    update: setNuxtNightly,
    note: `package.json now requires nuxt "${nuxtNightlyRange}" in place of "${nuxt}", because vite-hub/nuxt needs Nitro 3, and a Nuxt version before 4.7 runs Nitro 2. Nuxt 5 stops auto-importing Nitro helpers such as defineEventHandler in server code. Set experimental: { nitroAutoImports: true } to keep them while you migrate, or import them as the Nuxt 5 build error lists.`,
  }
}
