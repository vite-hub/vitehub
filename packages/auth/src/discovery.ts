import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"

import type { DiscoveredAuthDefinition } from "./types.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

const authDefinitionExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function serverAuthCandidates(serverDir: string): DiscoveredAuthDefinition[] {
  return authDefinitionExtensions.map(extension => ({
    handler: resolve(serverDir, `auth${extension}`),
    name: "default" as const,
    source: "server-auth" as const,
  }))
}

function rootAuthCandidates(rootDir: string): DiscoveredAuthDefinition[] {
  return authDefinitionExtensions.map(extension => ({
    handler: resolve(rootDir, `server.auth${extension}`),
    name: "default" as const,
    source: "server-auth-suffix" as const,
  }))
}

function existingDefinitions(candidates: DiscoveredAuthDefinition[]): DiscoveredAuthDefinition[] {
  return candidates.filter(definition => existsSync(definition.handler))
}

/**
 * Finds the Auth Definition. The first server directory is the application and later ones are Nuxt layers.
 * An application Definition replaces layer Definitions. Two Definitions at the same level fail discovery.
 */
export function discoverAuthDefinitions(rootDir: string, options: { serverDirs?: string[] } = {}): DiscoveredAuthDefinition[] {
  // An explicitly empty list disables server directory discovery. Only an omitted list uses `<rootDir>/server`.
  const [appServerDir, ...layerServerDirs] = options.serverDirs ?? [resolve(rootDir, "server")]
  const appDefinitions = existingDefinitions([...appServerDir ? serverAuthCandidates(appServerDir) : [], ...rootAuthCandidates(rootDir)])
  if (appDefinitions.length > 1) {
    throw authErrorDiagnostics.AUTH_R0003({ message: [
      "[vitehub] Only one Auth Definition is allowed. Found:",
      ...appDefinitions.map(definition => `  - ${definition.handler}`),
    ].join("\n") })
  }
  if (appDefinitions.length) return appDefinitions

  const layerDefinitions = existingDefinitions(layerServerDirs.flatMap(serverAuthCandidates))
  if (layerDefinitions.length > 1) {
    throw authErrorDiagnostics.AUTH_R0003({ message: [
      "[vitehub] Only one Auth Definition is allowed. More than one Nuxt layer defines one:",
      ...layerDefinitions.map(definition => `  - ${definition.handler}`),
      "Add `server/auth.ts` to the application to select the Auth Definition.",
    ].join("\n") })
  }
  return layerDefinitions
}

export function discoverAuthDefinition(rootDir: string, options: { serverDirs?: string[] } = {}): DiscoveredAuthDefinition | undefined {
  return discoverAuthDefinitions(rootDir, options)[0]
}

const abilitiesExtensions = [".ts", ".mts", ".js", ".mjs"]

/**
 * Finds the app's rules: `shared/abilities.ts` next to the server directory, which is the Nuxt `shared/` folder. Without
 * a server directory, `shared/abilities.ts` in the root. Two files with different extensions fail discovery.
 */
export function discoverAuthAbilities(rootDir: string, options: { serverDirs?: string[] } = {}): string | undefined {
  const serverDir = options.serverDirs?.[0] ?? resolve(rootDir, "server")
  const found = abilitiesExtensions
    .map(extension => resolve(dirname(serverDir), "shared", `abilities${extension}`))
    .filter(file => existsSync(file))
  if (found.length > 1) {
    throw authErrorDiagnostics.AUTH_C0060({ message: ["[vitehub] Only one abilities file is allowed. Found:", ...found.map(file => `  - ${file}`)].join("\n") })
  }
  return found[0]
}
