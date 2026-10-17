import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"

import { workflowDevGeneratedDir } from "./dev-registry.ts"
import { workflowPackageName } from "./vite-build.ts"

import type { WorkflowProvider } from "../types.ts"

// `vitehub workflow` runs its operations in the Nitro dev runtime, so it uses
// the same Workflow state and registry as the app. In `vite dev`, the Vite
// plugin writes these files and adds the handler as a development-only Nitro
// route. Build output never contains them.
const devHandlerFile = "dev-handler.mjs"
const devRuntimeFile = "dev-runtime.mjs"

export interface WorkflowDevGeneratedState {
  /** Workflow configuration error in the Vite config. */
  configError?: string
  /** Provider that the Vite config selects, or `null` when Workflow is disabled. */
  configuredProvider: WorkflowProvider | null
}

export function createWorkflowDevRuntimeModule(state: WorkflowDevGeneratedState, importBase = workflowPackageName): string {
  const options = {
    ...(state.configError ? { configError: state.configError } : {}),
    configuredProvider: state.configuredProvider,
  }
  return [
    `import { createWorkflowDevRequestHandler } from ${JSON.stringify(`${importBase}/runtime/dev`)}`,
    "",
    `export const handleWorkflowDevRequest = createWorkflowDevRequestHandler(${JSON.stringify(options)})`,
    "",
  ].join("\n")
}

async function writeIfChanged(file: string, contents: string): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => undefined)
  if (current === contents) return false
  await writeFile(file, contents, "utf8")
  return true
}

export interface WorkflowDevFilesOptions extends WorkflowDevGeneratedState {
  importBase?: string
  projectRoot: string
}

export interface WorkflowDevFiles {
  /** Files whose contents changed. */
  changed: string[]
  /** Nitro handler file of the development-only route. */
  handler: string
}

/**
 * Writes the development-only Nitro handler and the Workflow dev runtime
 * module. Files that did not change are not written again.
 */
export async function writeWorkflowDevFiles(options: WorkflowDevFilesOptions): Promise<WorkflowDevFiles> {
  const directory = resolve(options.projectRoot, workflowDevGeneratedDir)
  await mkdir(directory, { recursive: true })
  const handler = resolve(directory, devHandlerFile)
  const files: Array<[string, string]> = [
    [resolve(directory, devRuntimeFile), createWorkflowDevRuntimeModule(options, options.importBase)],
    [handler, renderViteHubNitroDevHandler({ export: "handleWorkflowDevRequest", module: `./${devRuntimeFile}` })],
  ]
  const changed: string[] = []
  for (const [file, contents] of files) {
    if (await writeIfChanged(file, contents)) changed.push(file)
  }
  return { changed, handler }
}
