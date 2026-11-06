import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

import { locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { dirname, join, resolve } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"

import type { LocateResult } from "@vite-hub/internal/config-edit"

export type SetupFramework = "vite" | "nuxt" | "none"
export type SetupPackageManager = "pnpm" | "npm" | "yarn" | "bun"

export interface SetupProject {
  root: string
  framework: SetupFramework
  packageManager: SetupPackageManager
  /** The config file name in `root`, such as `vite.config.ts`. */
  configFile?: string
  /** Where `vitehub()` options are in `configFile`. `undefined` when there is no config file. */
  config: LocateResult | undefined
  /** Static discovery directories; undefined when Nuxt directories or layers need evaluation. */
  serverDirs?: readonly string[]
  /** True when `name` is resolvable from the project or present in an ancestor's node_modules. */
  installed: (name: string) => boolean
}

const nuxtConfigFiles = ["nuxt.config.ts", "nuxt.config.mts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cts", "nuxt.config.cjs"]
const viteConfigFiles = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cts", "vite.config.cjs"]

const lockfiles: ReadonlyArray<readonly [string, SetupPackageManager]> = [
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
function detectPackageManager(root: string, manifest: PackageManifest | undefined, env: NodeJS.ProcessEnv): SetupPackageManager {
  const declared = packageManagerName(manifest?.packageManager)
  if (declared) return declared
  for (const folder of parentFolders(root)) {
    const found = lockfiles.find(([file]) => existsSync(join(folder, file)))
    if (found) return found[1]
  }
  return packageManagerName(env.npm_config_user_agent) ?? "npm"
}

function nuxtServerDirs(root: string, config: LocateResult | undefined): string[] | undefined {
  const nuxt = config?.ok ? config.site.nuxt : undefined
  if (!nuxt || nuxt.spread) return
  // Resolving extended and automatically registered layers requires loading their configs.
  const extended = nuxt.keys.extends
  if (extended && !(extended.kind === "literal" && Array.isArray(extended.value) && extended.value.length === 0)) return
  if (nuxt.keys._layers || nuxt.keys.srcDir || existsSync(join(root, "layers"))) return
  const rootDir = nuxt.keys.rootDir
  const serverDir = nuxt.keys.serverDir
  if (rootDir && (rootDir.kind !== "literal" || typeof rootDir.value !== "string")) return
  if (serverDir && (serverDir.kind !== "literal" || typeof serverDir.value !== "string")) return
  const appRoot = rootDir?.kind === "literal" && typeof rootDir.value === "string" ? resolve(root, rootDir.value) : root
  if (existsSync(join(appRoot, "layers"))) return
  return [resolve(appRoot, serverDir?.kind === "literal" && typeof serverDir.value === "string" ? serverDir.value || "server" : "server")]
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
  const configFile = framework === "nuxt" ? nuxtConfig ?? viteConfig : viteConfig
  const config = configFile ? locateViteHubConfig(configFile, await readFile(join(root, configFile), "utf8")) : undefined
  const folders = parentFolders(root)
  const require = createRequire(join(root, "package.json"))
  return {
    config,
    ...(configFile ? { configFile } : {}),
    framework,
    installed: (name) => {
      // Yarn PnP and other active loader hooks can resolve packages without node_modules.
      // Resolve metadata or an entry point without evaluating either one.
      for (const specifier of [`${name}/package.json`, name]) {
        try {
          require.resolve(specifier)
          return true
        }
        catch {}
      }
      return folders.some(folder => existsSync(join(folder, "node_modules", name, "package.json")))
    },
    packageManager: detectPackageManager(root, manifest, env),
    root,
    serverDirs: framework === "nuxt" ? nuxtServerDirs(root, config) : [join(root, "server")],
  }
}
