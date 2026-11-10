import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "pathe"

import { toStepPropertyName } from "../runtime/execute.ts"

import type { DiscoveredWorkflowDefinition } from "../types.ts"

export const workflowTypesFile = ".vitehub/workflow.d.ts"

/** Types `steps` in `defineWorkflow(name, handler)` with the step files of each folder Workflow. */
export function createWorkflowTypes(file: string, definitions: DiscoveredWorkflowDefinition[], importBase = "@vite-hub/workflow"): string {
  const entries = definitions.filter(definition => definition.steps?.length).flatMap((definition) => {
    const directory = /\.(?:c|m)?[jt]s$/i.test(definition.handler) ? dirname(definition.handler) : definition.handler
    return [
      `    ${JSON.stringify(definition.name)}: {`,
      ...definition.steps!.flatMap((step) => {
        const path = relative(dirname(file), step)
        const specifier = path.startsWith(".") ? path : `./${path}`
        return [
          ...(/\.(?:c|m)?js$/i.test(step) ? ["      // @ts-ignore JavaScript steps may have no declarations when allowJs is disabled."] : []),
          `      ${JSON.stringify(toStepPropertyName(relative(directory, step)))}: typeof import(${JSON.stringify(specifier)}).default`,
        ]
      }),
      "    }",
    ]
  })
  return [
    `import ${JSON.stringify(importBase)}`,
    `declare module ${JSON.stringify(importBase)} {`,
    "  interface WorkflowStepRegistry {",
    ...entries,
    "  }",
    "}",
    "",
  ].join("\n")
}

/**
 * Writes `.vitehub/workflow.d.ts` when its contents change. Keep an empty declaration before the first
 * folder step so ViteHub's types entry can reference it throughout a development session.
 */
export async function writeWorkflowTypes(root: string, definitions: DiscoveredWorkflowDefinition[], importBase = "@vite-hub/workflow"): Promise<void> {
  const file = resolve(root, workflowTypesFile)
  const contents = createWorkflowTypes(file, definitions, importBase)
  const current = await readFile(file, "utf8").catch(() => undefined)
  if (current === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}
