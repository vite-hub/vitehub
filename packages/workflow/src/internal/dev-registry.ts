import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createWorkflowRegistryContents, workflowPackageName } from "./vite-build.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions } from "../types.ts"

// Provider servers install the discovered Workflow registry in production. In
// `vite dev`, the app runs in the Nitro dev runtime, so the Vite plugin writes
// the registry and a Nitro plugin that installs it and the runtime config at startup. Build output
// never contains these files.
export const workflowDevGeneratedDir = ".vitehub/nitro/workflow"
const devRegistryFile = "dev-registry.mjs"
const devPluginFile = "dev-plugin.mjs"

/**
 * Agent Workflows need the Agent registry transform of the provider build, so
 * the development registry does not contain them.
 */
export function isWorkflowDevDefinition(definition: DiscoveredWorkflowDefinition): boolean {
  return definition.source !== "agent-workflow" && definition.source !== "agent-workflow-recovery"
}

export function discoverWorkflowDevDefinitions(rootDir: string, serverDirs?: string[]): DiscoveredWorkflowDefinition[] {
  return discoverWorkflowDefinitions({ rootDir, serverDirs }).filter(isWorkflowDevDefinition)
}

export function createWorkflowDevRegistryModule(registryFile: string, definitions: DiscoveredWorkflowDefinition[], importBase = workflowPackageName): string {
  return createWorkflowRegistryContents(registryFile, definitions.filter(isWorkflowDevDefinition), { workflow: importBase })
}

export function createWorkflowDevPluginModule(workflow: false | ResolvedWorkflowOptions, importBase = workflowPackageName): string {
  return [
    "import { definePlugin } from \"nitro\"",
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(`${importBase}/runtime/state`)}`,
    `import registry from ${JSON.stringify(`./${devRegistryFile}`)}`,
    "",
    "export default definePlugin(() => {",
    `  setWorkflowRuntimeConfig(${JSON.stringify(workflow)})`,
    "  setWorkflowRuntimeRegistry(registry)",
    "})",
    "",
  ].join("\n")
}

async function writeIfChanged(file: string, contents: string): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => undefined)
  if (current === contents) return false
  await writeFile(file, contents, "utf8")
  return true
}

export interface WorkflowDevRegistryFilesOptions {
  definitions: DiscoveredWorkflowDefinition[]
  importBase?: string
  projectRoot: string
  /** Retain the startup path Nitro read before final Vite configuration. */
  pluginPath?: string
  workflow: false | ResolvedWorkflowOptions
}

export interface WorkflowDevRegistryFiles {
  /** Files whose contents changed. */
  changed: string[]
  /** Nitro plugin that installs the registry and runtime configuration. */
  plugin: string
}

/**
 * Writes the development registry of discovered Workflow Definitions and the
 * Nitro plugin that installs it and the runtime configuration. Files that did
 * not change are not written again.
 */
export async function writeWorkflowDevRegistryFiles(options: WorkflowDevRegistryFilesOptions): Promise<WorkflowDevRegistryFiles> {
  const directory = resolve(options.projectRoot, workflowDevGeneratedDir)
  await mkdir(directory, { recursive: true })
  const registry = resolve(directory, devRegistryFile)
  const plugin = resolve(directory, devPluginFile)
  const files: Array<[string, string]> = [
    [registry, createWorkflowDevRegistryModule(registry, options.definitions, options.importBase)],
    [plugin, createWorkflowDevPluginModule(options.workflow, options.importBase)],
  ]
  if (options.pluginPath && options.pluginPath !== plugin) {
    const pluginImport = `./${relative(dirname(options.pluginPath), plugin).replace(/\\/g, "/")}`
    files.push([options.pluginPath, `export { default } from ${JSON.stringify(pluginImport)}\n`])
  }
  const changed: string[] = []
  for (const [file, contents] of files) {
    if (await writeIfChanged(file, contents)) changed.push(file)
  }
  return { changed, plugin: options.pluginPath ?? plugin }
}
