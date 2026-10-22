import { resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredDefinition } from "@vite-hub/internal/definition-catalog"

/**
 * Lists the task files below each `<server dir>/tasks`. The name follows Nitro: the path without the extension and
 * `/index`, with `/` replaced by `:`. For example, `server/tasks/db/seed.ts` is `db:seed`.
 */
export function discoverTaskDefinitions(projectRoot: string, serverDirs?: readonly string[]): DiscoveredDefinition[] {
  const scanDirs = serverDirs?.length ? [...serverDirs] : [resolve(projectRoot, "server")]
  return discoverDefinitions("task", [
    createDirectoryDefinitionSource("server-tasks", scanDirs, "tasks", {
      normalizeName: (directory, file) => normalizePathDefinitionName(directory, file).replaceAll("/", ":"),
    }),
  ])
}
