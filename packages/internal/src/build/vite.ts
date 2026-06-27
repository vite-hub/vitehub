import { statSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

type NoExternalValue = string | true | RegExp | (string | RegExp)[] | undefined
type WatchIgnoredMatcher = string | RegExp | ((testString: string, ...args: unknown[]) => boolean)
type WatchIgnoredValue = WatchIgnoredMatcher | WatchIgnoredMatcher[] | undefined

const generatedViteHubFilesPattern = "**/.vitehub/**"
const projectRootDirectoryMarkers = [
  ["server", "agents"],
  ["server", "schedules"],
  ["server", "workspaces"],
]
const projectRootFileMarkers = [
  ["package.json"],
]

export const VITEHUB_ENV_PUBLIC_ID = "#vitehub/env/public" as const
export const VITEHUB_ENV_SERVER_ID = "#vitehub/env/server" as const

export function createNoExternalMerger(packageName: string) {
  return (current: NoExternalValue): NoExternalValue => {
    if (current === true) {
      return true
    }
    if (!current) {
      return [packageName]
    }
    const values = Array.isArray(current) ? current : [current]
    return values.includes(packageName) ? values : [...values, packageName]
  }
}

export function isServerEnvironment(name: string, config: { consumer?: string }): boolean {
  return name === "ssr" || config.consumer === "server"
}

export function shouldSkipViteProviderBuild(command: "build" | "serve" | undefined, mode?: string): boolean {
  return command === "serve" || mode === "e2e"
}

export function mergeGeneratedViteHubWatchIgnored(ignored: WatchIgnoredValue): WatchIgnoredValue {
  if (!ignored) return [generatedViteHubFilesPattern]
  if (Array.isArray(ignored)) {
    return ignored.includes(generatedViteHubFilesPattern) ? ignored : [...ignored, generatedViteHubFilesPattern]
  }
  return [ignored, generatedViteHubFilesPattern]
}

export function resolveViteHubProjectRoot(root: string, options: { projectRoot?: string } = {}): string {
  const resolvedRoot = resolve(root)
  if (options.projectRoot) return resolve(resolvedRoot, options.projectRoot)

  if (basename(resolvedRoot) === "app") {
    const parent = dirname(resolvedRoot)
    if (hasProjectRootDirectoryMarker(parent)) return parent
  }

  let current = resolvedRoot
  while (true) {
    if (hasProjectRootMarker(current)) return current

    const parent = dirname(current)
    if (parent === current) return resolvedRoot
    current = parent
  }
}

function hasProjectRootDirectoryMarker(root: string): boolean {
  for (const marker of projectRootDirectoryMarkers) {
    try {
      if (statSync(resolve(root, ...marker)).isDirectory()) return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return false
}

function hasProjectRootMarker(root: string): boolean {
  if (hasProjectRootDirectoryMarker(root)) return true
  for (const marker of projectRootFileMarkers) {
    try {
      if (statSync(resolve(root, ...marker)).isFile()) return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return false
}

export function viteHubEnvAmbientTypesPath(root: string): string {
  return resolve(root, ".vitehub", "types", "env.d.ts")
}

export function viteHubEnvPublicModulePath(root: string): string {
  return resolve(root, ".vitehub", "env", "public.mjs")
}

export function viteHubEnvPublicModuleTypesPath(root: string): string {
  return resolve(root, ".vitehub", "env", "public.d.ts")
}

export function viteHubEnvServerModulePath(root: string): string {
  return resolve(root, ".vitehub", "env", "server.mjs")
}

export function viteHubEnvServerModuleTypesPath(root: string): string {
  return resolve(root, ".vitehub", "env", "server.d.ts")
}

export function createViteHubEnvImportAliases(root: string): Record<string, string> {
  return {
    [VITEHUB_ENV_PUBLIC_ID]: viteHubEnvPublicModulePath(root),
    [VITEHUB_ENV_SERVER_ID]: viteHubEnvServerModulePath(root),
  }
}
