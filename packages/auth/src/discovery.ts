import { existsSync } from "node:fs"
import { resolve } from "node:path"

import type { DiscoveredAuthDefinition } from "./types.ts"

const authDefinitionExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function authDefinitionCandidates(rootDir: string): DiscoveredAuthDefinition[] {
  return authDefinitionExtensions.flatMap((extension) => [
    {
      handler: resolve(rootDir, "server", `auth${extension}`),
      name: "default" as const,
      source: "server-auth" as const,
    },
    {
      handler: resolve(rootDir, `server.auth${extension}`),
      name: "default" as const,
      source: "server-auth-suffix" as const,
    },
  ])
}

export function discoverAuthDefinitions(rootDir: string): DiscoveredAuthDefinition[] {
  const definitions = authDefinitionCandidates(rootDir).filter(definition => existsSync(definition.handler))
  if (definitions.length > 1) {
    throw new Error([
      "[vitehub] Only one Auth Definition is allowed. Found:",
      ...definitions.map(definition => `  - ${definition.handler}`),
    ].join("\n"))
  }
  return definitions
}

export function discoverAuthDefinition(rootDir: string): DiscoveredAuthDefinition | undefined {
  return discoverAuthDefinitions(rootDir)[0]
}
