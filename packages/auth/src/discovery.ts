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

/** Finds the app's Auth client options, `auth.client.ts`, in the Vite root, which is `app/` in a Nuxt app. */
export function discoverAuthClient(appDir: string): string | undefined {
  return authDefinitionExtensions.map(extension => resolve(appDir, `auth.client${extension}`)).find(file => existsSync(file))
}

export function discoverAuthDefinition(rootDir: string, options: { serverDirs?: string[] } = {}): DiscoveredAuthDefinition | undefined {
  return discoverAuthDefinitions(rootDir, options)[0]
}

const abilitiesExtensions = [".ts", ".mts", ".js", ".mjs"]

/** The app's candidates come first; the remaining candidates belong to Nuxt layers. */
export function authAbilitiesCandidates(rootDir: string, options: { serverDirs?: string[] } = {}) {
  const [appServerDir = resolve(rootDir, "server"), ...layerServerDirs] = options.serverDirs ?? []
  const candidates = (serverDir: string) => abilitiesExtensions.map(extension => resolve(dirname(serverDir), "shared", `abilities${extension}`))
  return { app: candidates(appServerDir), layers: layerServerDirs.flatMap(candidates) }
}

/** The app replaces layer rules. Without app rules, exactly one layer may provide them. */
export function discoverAuthAbilities(rootDir: string, options: { serverDirs?: string[] } = {}): string | undefined {
  const candidates = authAbilitiesCandidates(rootDir, options)
  const app = candidates.app.filter(file => existsSync(file))
  const found = app.length ? app : candidates.layers.filter(file => existsSync(file))
  if (found.length > 1) {
    throw authErrorDiagnostics.AUTH_C0060({ message: ["[vitehub] Only one abilities file is allowed. Found:", ...found.map(file => `  - ${file}`)].join("\n") })
  }
  return found[0]
}
