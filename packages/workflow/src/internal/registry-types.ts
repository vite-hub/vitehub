import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "pathe"

import { toStepPropertyName } from "../runtime/execute.ts"

import type { DiscoveredWorkflowDefinition } from "../types.ts"

export const workflowTypesFile = ".vitehub/workflow.d.ts"

const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const javaScriptFilePattern = /\.(?:c|m)?js$/i
const ignoreJavaScriptTypes = "// @ts-ignore JavaScript files may have no declarations when allowJs is disabled."

function importSpecifier(file: string, target: string): string {
  const path = relative(dirname(file), target)
  return path.startsWith(".") ? path : `./${path}`
}

/**
 * Types `startWorkflow()` with the name and payload of each Workflow Definition (`WorkflowRegistry`), and `steps` with
 * the step files of each folder Workflow (`WorkflowStepRegistry`).
 */
export function createWorkflowTypes(file: string, definitions: DiscoveredWorkflowDefinition[], importBase = "@vite-hub/workflow"): string {
  const registryEntries = definitions.flatMap((definition) => {
    // A folder of step files without `index.ts` passes each step result to the next step, so its payload is unknown.
    if (!sourceFilePattern.test(definition.handler)) return [`    ${JSON.stringify(definition.name)}: import(${JSON.stringify(importBase)}).WorkflowDefinition<unknown>`]
    return [
      ...(javaScriptFilePattern.test(definition.handler) ? [`    ${ignoreJavaScriptTypes}`] : []),
      `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(importSpecifier(file, definition.handler))}).default`,
    ]
  })
  const stepEntries = definitions.filter(definition => definition.steps?.length).flatMap((definition) => {
    const directory = sourceFilePattern.test(definition.handler) ? dirname(definition.handler) : definition.handler
    return [
      `    ${JSON.stringify(definition.name)}: {`,
      ...definition.steps!.flatMap(step => [
        ...(javaScriptFilePattern.test(step) ? [`      ${ignoreJavaScriptTypes}`] : []),
        `      ${JSON.stringify(toStepPropertyName(relative(directory, step)))}: typeof import(${JSON.stringify(importSpecifier(file, step))}).default`,
      ]),
      "    }",
    ]
  })
  return [
    `import ${JSON.stringify(importBase)}`,
    `declare module ${JSON.stringify(importBase)} {`,
    "  interface WorkflowRegistry {",
    ...registryEntries,
    "  }",
    "  interface WorkflowStepRegistry {",
    ...stepEntries,
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
