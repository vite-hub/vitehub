import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "pathe"

import type { DiscoveredQueueDefinition } from "./types.ts"

export function createQueueTypes(file: string, definitions: DiscoveredQueueDefinition[], importBase = "@vite-hub/queue"): string {
  const entries = definitions.map((definition) => {
    const path = relative(dirname(file), definition.handler)
    const specifier = path.startsWith(".") ? path : `./${path}`
    return `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(specifier)}).default`
  })
  return [
    `import ${JSON.stringify(importBase)}`,
    `declare module ${JSON.stringify(importBase)} {`,
    '  interface QueueRegistry {',
    ...entries,
    '  }',
    '}',
    '',
  ].join("\n")
}

export async function writeQueueTypes(root: string, definitions: DiscoveredQueueDefinition[], importBase = "@vite-hub/queue"): Promise<void> {
  const file = resolve(root, ".vitehub/queue.d.ts")
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, createQueueTypes(file, definitions, importBase), "utf8")
}
