import { existsSync } from "node:fs"
import { resolve } from "node:path"

import type { DiscoveredAuthDefinition } from "./types.ts"

const authDefinitionExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function authDefinitionCandidates(rootDir: string, serverDirs = [resolve(rootDir, "server")]): DiscoveredAuthDefinition[] {
  return authDefinitionExtensions.flatMap((extension) => [
    ...serverDirs.map(serverDir => ({
      handler: resolve(serverDir, `auth${extension}`),
      name: "default" as const,
      source: "server-auth" as const,
    })),
    {
      handler: resolve(rootDir, `server.auth${extension}`),
      name: "default" as const,
      source: "server-auth-suffix" as const,
    },
  ])
}

export function discoverAuthDefinitions(rootDir: string, options: { serverDirs?: string[] } = {}): DiscoveredAuthDefinition[] {
  const definitions = authDefinitionCandidates(rootDir, options.serverDirs).filter(definition => existsSync(definition.handler))
  if (definitions.length > 1) {
    throw new Error([
      "[vitehub] Only one Auth Definition is allowed. Found:",
      ...definitions.map(definition => `  - ${definition.handler}`),
    ].join("\n"))
  }
  return definitions
}

export function discoverAuthDefinition(rootDir: string, options: { serverDirs?: string[] } = {}): DiscoveredAuthDefinition | undefined {
  return discoverAuthDefinitions(rootDir, options)[0]
}
