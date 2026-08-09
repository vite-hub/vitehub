import { resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredRealtimeDefinition } from "./types.ts"

export function discoverRealtimeDefinitions(rootDir: string, serverDirs?: string[]): DiscoveredRealtimeDefinition[] {
  return discoverDefinitions("realtime", [
    createDirectoryDefinitionSource("server-realtime", serverDirs ?? [resolve(rootDir, "server")], "realtime", {
      createDefinition: ({ file, name }) => ({ handler: file, name, source: "server-realtime" }),
      normalizeName: normalizePathDefinitionName,
    }),
  ])
}
