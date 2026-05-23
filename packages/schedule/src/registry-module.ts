import { relative, resolve } from "node:path"

import type { DiscoveredScheduleDefinition } from "./types.ts"

export const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"

function createImportExpression(registryFile: string, file: string): string {
  const importPath = relative(resolve(registryFile, ".."), file)
  return `import(${JSON.stringify(importPath.startsWith(".") ? importPath : `./${importPath}`)})`
}

export function createScheduleRegistryContents(registryFile: string, definitions: DiscoveredScheduleDefinition[]): string {
  const imports = definitions.some(definition => definition.source === "agent-inline-schedule")
    ? [`import { runScheduledAgent } from "@vitehub/agent"`]
    : []

  return [
    ...imports,
    "",
    "const registry = {",
    ...definitions.map((definition) => {
      if (definition.source !== "agent-inline-schedule") {
        return `  ${JSON.stringify(definition.name)}: async () => ${createImportExpression(registryFile, definition.handler)},`
      }
      const agentExpression = definition.agentExportName
        ? `(await ${createImportExpression(registryFile, definition.handler)})[${JSON.stringify(definition.agentExportName)}]`
        : `(await ${createImportExpression(registryFile, definition.handler)}).default`
      const scheduleId = definition.name.split("/").at(-1) || definition.name
      return [
        `  ${JSON.stringify(definition.name)}: async () => ({`,
        `    cron: ${JSON.stringify(definition.cron || "")},`,
        "    handler: async (context) => runScheduledAgent(",
        `      ${agentExpression},`,
        "      context,",
        "    ),",
        `    options: { id: ${JSON.stringify(scheduleId)}, target: ${JSON.stringify(definition.agentName || definition.name)} },`,
        "  }),",
      ].join("\n")
    }),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}
