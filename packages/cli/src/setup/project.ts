import { existsSync, realpathSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { delimiter, sep } from "node:path"
import process from "node:process"

import { locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { dirname, join, resolve } from "pathe"
import { parse as parseRc } from "rc9"
import { minVersion, Range, subset, validRange } from "semver"
import { parseDocument } from "yaml"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"

import type { LocateResult } from "@vite-hub/internal/config-edit"

export type SetupFramework = "vite" | "nuxt" | "none"
export type SetupPackageManager = "pnpm" | "npm" | "yarn" | "bun"

export interface SetupProject {
  root: string
  framework: SetupFramework
  packageManager: SetupPackageManager
  /** Where `packageManager` comes from. `default` means npm, because nothing named one. */
  packageManagerSource: "manifest" | "lockfile" | "user-agent" | "default"
  /** The config file name in `root`, such as `vite.config.ts`. */
  configFile?: string
  /** Where `vitehub()` options are in `configFile`. `undefined` when there is no config file. */
  config: LocateResult | undefined
  /** The text of `configFile` that `config` was read from. */
  configSource?: string
  /** True when the target manifest declares `name` for production, or for development when `dev` is true. */
  declared: (name: string, dev: boolean) => boolean
  /** The `nuxt` range from the manifest or its pnpm catalog. */
  nuxt?: string
  /** Static discovery directories; undefined when Nuxt directories or layers need evaluation. */
  serverDirs?: readonly string[]
  /** True when `name` is resolvable from the project or present in an ancestor's node_modules. */
  installed: (name: string) => boolean
}

/**
 * The Nuxt releases that a `nuxt` range allows, as a semver range. A Nuxt 5 nightly counts as its release, so
 * `npm:nuxt-nightly@5.0.0-2611071848-2d8337c` is `5.0.0`. The `5x` channel tag of `nuxt-nightly` is `5.x`.
 * `undefined` for another tag or a range without a version.
 */
export function nuxtReleases(nuxt: unknown): string | undefined {
  if (typeof nuxt !== "string") return undefined
  const range = validRange(nuxt.replace(/^npm:nuxt-nightly@(\d+)x$/u, "$1.x").replace(/^npm:nuxt(?:-nightly)?@/u, ""))
  if (!range || !minVersion(range)) return undefined
  return new Range(range).set.map(comparators => comparators.map(({ operator, semver, value }) =>
    typeof semver !== "symbol" && semver.major === 5 && semver.prerelease.length > 0
      ? `${operator}5.${semver.minor}.${semver.patch}`
      : value).join(" ")).join(" || ")
}

/** True when a `nuxt` range allows only Nuxt 5, so `vitehub init --nuxt-nightly` creates the same app. */
export function declaresNuxt5(nuxt: unknown): boolean {
  const releases = nuxtReleases(nuxt)
  return !!releases && subset(releases, ">=5.0.0 <6.0.0")
}

const nuxtConfigFiles = ["nuxt.config.ts", "nuxt.config.mts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cts", "nuxt.config.cjs"]
const viteConfigFiles = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cts", "vite.config.cjs"]

/** The lockfiles and workspace files that name a package manager, in the order that detection reads them. */
export const setupLockfiles: ReadonlyArray<readonly [string, SetupPackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-workspace.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
]

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}

function parentFolders(root: string): string[] {
  const folders = [root]
  for (let folder = dirname(root); folder !== folders.at(-1); folder = dirname(folder)) folders.push(folder)
  return folders
}

export function pnpmWorkspaceFile(root: string): string | undefined {
  return parentFolders(root).map(folder => join(folder, "pnpm-workspace.yaml")).find(existsSync)
}

async function resolveNuxtSpecifier(root: string, specifier: unknown): Promise<string | undefined> {
  if (typeof specifier !== "string") return undefined
  if (!specifier.startsWith("catalog:")) return specifier
  const file = pnpmWorkspaceFile(root)
  if (!file) return undefined
  const workspace = parseDocument(await readFile(file, "utf8"))
  if (workspace.errors.length) return undefined
  const catalog = specifier.slice("catalog:".length)
  const entry: unknown = workspace.getIn(catalog && catalog !== "default" ? ["catalogs", catalog, "nuxt"] : ["catalog", "nuxt"])
  return typeof entry === "string" ? entry : undefined
}

async function readManifest(root: string): Promise<PackageManifest | undefined> {
  const file = join(root, "package.json")
  if (!existsSync(file)) return
  const value: unknown = JSON.parse(await readFile(file, "utf8"))
  return value && typeof value === "object" ? value : {}
}

function packageManagerName(value: string | undefined): SetupPackageManager | undefined {
  const name = value?.trim().split(/[@/ ]/u)[0]
  return name === "pnpm" || name === "npm" || name === "yarn" || name === "bun" ? name : undefined
}

/** `packageManager` in package.json, then a lockfile in `root` or a parent folder, then the user agent, then npm. */
export function detectPackageManager(root: string, manifest: PackageManifest | undefined, env: NodeJS.ProcessEnv): Pick<SetupProject, "packageManager" | "packageManagerSource"> {
  const declared = packageManagerName(manifest?.packageManager)
  if (declared) return { packageManager: declared, packageManagerSource: "manifest" }
  for (const folder of parentFolders(root)) {
    const found = setupLockfiles.find(([file]) => existsSync(join(folder, file)))
    if (found) return { packageManager: found[1], packageManagerSource: "lockfile" }
  }
  const agent = packageManagerName(env.npm_config_user_agent)
  return agent ? { packageManager: agent, packageManagerSource: "user-agent" } : { packageManager: "npm", packageManagerSource: "default" }
}

const nuxtLayerKeys = ["extends", "_extends", "theme", "_layers"]

function nuxtDirectoryOverride(value: unknown): boolean {
  return value !== null && typeof value === "object"
    && ["rootDir", "serverDir", ...nuxtLayerKeys].some(key => Object.hasOwn(value, key))
}

async function nuxtRcAllowsStaticDiscovery(folder: string): Promise<boolean> {
  const file = join(folder, ".nuxtrc")
  try {
    if (!(await stat(file)).isFile()) return false
    return !nuxtDirectoryOverride(parseRc(await readFile(file, "utf8")))
  }
  catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
  }
}

async function nuxtServerDirs(root: string, config: LocateResult | undefined, env: NodeJS.ProcessEnv): Promise<string[] | undefined> {
  const nuxt = config?.ok ? config.site.nuxt : undefined
  if (!nuxt || nuxt.spread) return
  for (const key of nuxtLayerKeys) {
    const layer = nuxt.keys[key]
    if (layer && !(layer.kind === "literal" && Array.isArray(layer.value) && layer.value.length === 0)) return
  }
  for (const [key, override] of Object.entries(nuxt.keys)) {
    if (!key.startsWith("$") || key === "$meta") continue
    if (override.kind === "expression") return
    if (key === "$env") {
      if (override.value !== null && typeof override.value === "object" && Object.values(override.value).some(nuxtDirectoryOverride)) return
    }
    else if (nuxtDirectoryOverride(override.value)) return
  }
  if (existsSync(join(root, "layers"))) return
  const rootDir = nuxt.keys.rootDir
  const serverDir = nuxt.keys.serverDir
  if (rootDir && (rootDir.kind !== "literal" || typeof rootDir.value !== "string")) return
  if (serverDir && (serverDir.kind !== "literal" || typeof serverDir.value !== "string")) return
  const appRoot = rootDir?.kind === "literal" && typeof rootDir.value === "string" ? resolve(root, rootDir.value) : root
  if (existsSync(join(appRoot, "layers"))) return
  const home = homedir()
  for (const folder of new Set([...parentFolders(root), home, env.XDG_CONFIG_HOME || join(home, ".config")])) {
    if (!await nuxtRcAllowsStaticDiscovery(folder)) return
  }
  return [resolve(appRoot, serverDir?.kind === "literal" && typeof serverDir.value === "string" ? serverDir.value || "server" : "server")]
}

function globalPackageDirs(name: string): string[] {
  return (process.env.NODE_PATH ?? "").split(delimiter).filter(Boolean).flatMap((dir) => {
    try {
      return [realpathSync(join(dir, name))]
    }
    catch {
      return []
    }
  })
}

/**
 * Reads the project in `root` without loading its config: the config file is parsed, never run.
 * Throws `SETUP_NOT_A_PROJECT` when `root` has no package.json and no Vite or Nuxt config.
 */
export async function readSetupProject(root: string, env: NodeJS.ProcessEnv): Promise<SetupProject> {
  root = resolve(root)
  const manifest = await readManifest(root)
  const dependencies = { ...manifest?.devDependencies, ...manifest?.dependencies }
  const nuxtConfig = nuxtConfigFiles.find(file => existsSync(join(root, file)))
  const viteConfig = viteConfigFiles.find(file => existsSync(join(root, file)))
  if (!manifest && !nuxtConfig && !viteConfig) throw cliErrorDiagnostics.SETUP_NOT_A_PROJECT({ root })

  const framework: SetupFramework = nuxtConfig || dependencies.nuxt ? "nuxt" : viteConfig || dependencies.vite ? "vite" : "none"
  const configFile = framework === "nuxt" ? nuxtConfig : viteConfig
  const configSource = configFile ? await readFile(join(root, configFile), "utf8") : undefined
  let config = configFile && configSource !== undefined ? locateViteHubConfig(configFile, configSource) : undefined
  if (framework === "nuxt" && (!config || (!config.ok && config.reason === "no-vitehub")) && existsSync(join(root, "layers"))) config = { ok: false, reason: "dynamic-options" }
  const folders = parentFolders(root)
  const require = createRequire(join(root, "package.json"))
  const nuxt = await resolveNuxtSpecifier(root, dependencies.nuxt)
  return {
    config,
    ...(configFile ? { configFile, configSource } : {}),
    framework,
    declared: (name, dev) => Object.hasOwn(manifest?.dependencies ?? {}, name) || (dev && Object.hasOwn(manifest?.devDependencies ?? {}, name)),
    installed: (name) => {
      if (folders.some(folder => existsSync(join(folder, "node_modules", name, "package.json")))) return true
      const globalCopies = globalPackageDirs(name)
      for (const specifier of [`${name}/package.json`, name]) {
        try {
          const file = realpathSync(require.resolve(specifier))
          if (!globalCopies.some(dir => file.startsWith(`${dir}${sep}`))) return true
        }
        catch {}
      }
      return false
    },
    ...detectPackageManager(root, manifest, env),
    ...(nuxt === undefined ? {} : { nuxt }),
    root,
    serverDirs: framework === "nuxt" ? await nuxtServerDirs(root, config, env) : [join(root, "server")],
  }
}
