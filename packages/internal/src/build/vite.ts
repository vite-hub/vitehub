import { statSync } from "node:fs"
import { dirname, resolve } from "node:path"

type NoExternalValue = string | true | RegExp | (string | RegExp)[] | undefined
type WatchIgnoredMatcher = string | RegExp | ((testString: string, ...args: unknown[]) => boolean)
type WatchIgnoredValue = WatchIgnoredMatcher | WatchIgnoredMatcher[] | undefined

const generatedViteHubFilesPattern = "**/.vitehub/**"
const projectRootMarkers = [
  ["server", "agents"],
  ["server", "schedules"],
  ["server", "workspaces"],
]

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

export function mergeGeneratedViteHubWatchIgnored(ignored: WatchIgnoredValue): WatchIgnoredValue {
  if (!ignored) return [generatedViteHubFilesPattern]
  if (Array.isArray(ignored)) {
    return ignored.includes(generatedViteHubFilesPattern) ? ignored : [...ignored, generatedViteHubFilesPattern]
  }
  return [ignored, generatedViteHubFilesPattern]
}

export function resolveViteHubProjectRoot(root: string): string {
  const resolvedRoot = resolve(root)

  let current = resolvedRoot
  while (true) {
    if (hasProjectRootMarker(current)) return current

    const parent = dirname(current)
    if (parent === current) return resolvedRoot
    current = parent
  }
}

function hasProjectRootMarker(root: string): boolean {
  for (const marker of projectRootMarkers) {
    try {
      if (statSync(resolve(root, ...marker)).isDirectory()) return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return false
}
