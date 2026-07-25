import { existsSync } from "node:fs"
import { resolve } from "node:path"

export interface DiscoveredEmailDefinition {
  handler: string
  name: "default"
  source: "server-email" | "server-email-suffix"
}

const emailDefinitionExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

export function discoverEmailDefinition(root: string, options: { serverDirs?: string[] } = {}): DiscoveredEmailDefinition | undefined {
  const serverDirs = options.serverDirs ?? [resolve(root, "server")]
  const definitions = emailDefinitionExtensions.flatMap(extension => [
    ...serverDirs.map(serverDir => ({
      handler: resolve(serverDir, `email${extension}`),
      name: "default" as const,
      source: "server-email" as const,
    })),
    {
      handler: resolve(root, `server.email${extension}`),
      name: "default" as const,
      source: "server-email-suffix" as const,
    },
  ]).filter(definition => existsSync(definition.handler))
  if (definitions.length > 1) {
    throw new Error([
      "[vitehub] Only one Email Definition is allowed. Found:",
      ...definitions.map(definition => `  - ${definition.handler}`),
    ].join("\n"))
  }
  return definitions[0]
}
