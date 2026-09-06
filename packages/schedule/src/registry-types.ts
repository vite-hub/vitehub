import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import type { DiscoveredScheduleDefinition } from "./types.ts"

export function createScheduleTypes(file: string, definitions: DiscoveredScheduleDefinition[], importBase = "@vite-hub/schedule"): string {
  const entries = definitions.filter(definition => definition.allowRuntimeSchedules).map((definition) => {
    const path = relative(dirname(file), definition.handler).replaceAll("\\", "/")
    const specifier = path.startsWith(".") ? path : `./${path}`
    return `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(specifier)}).default`
  })
  return [
    `import ${JSON.stringify(importBase)}`,
    `declare module ${JSON.stringify(importBase)} {`,
    '  interface ScheduleTargetRegistry {',
    ...entries,
    '  }',
    '}',
    '',
  ].join("\n")
}

export async function writeScheduleTypes(root: string, definitions: DiscoveredScheduleDefinition[], importBase = "@vite-hub/schedule"): Promise<void> {
  const file = resolve(root, ".vitehub/schedule.d.ts")
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, createScheduleTypes(file, definitions, importBase), "utf8")
}
