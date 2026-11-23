import { mkdir, readFile, writeFile } from "node:fs/promises"
import { workflowRuntimeModule } from "./runtime-modules.ts"
import { dirname, relative, resolve } from "node:path"

import { createImportPath } from "@vite-hub/internal/build/paths"

import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createWorkflowRegistryContents, installedAgentWorkflowModules, withAgentInvocationRecoveryDefinitions } from "./vite-build.ts"

import { defaultOpenWorkflowSqlitePath } from "./openworkflow-defaults.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions } from "../types.ts"
import type { AgentWorkflowModules } from "./vite-build.ts"

export const workflowDevGeneratedDir = ".vitehub/nitro/workflow"
export const workflowTestSetupFile = "test-setup.mjs"
const devRegistryFile = "dev-registry.mjs"
const devPluginFile = "dev-plugin.mjs"

/**
 * The Workflow Definitions of the startup registry. With `agents`, it also has each discovered Agent Workflow and its
 * invocation recovery Workflow, as a provider build does. OpenWorkflow needs them: its worker registers the
 * definitions of this registry when it starts, and runs only those. Other providers keep running Agent turns inline.
 */
export function discoverWorkflowDevDefinitions(rootDir: string, serverDirs?: string[], agents = false): DiscoveredWorkflowDefinition[] {
  return agents
    ? withAgentInvocationRecoveryDefinitions(discoverWorkflowDefinitions({ rootDir, serverDirs }))
    : discoverWorkflowDefinitions({ mode: "standalone", rootDir, serverDirs })
}

/** True when the startup registry must have the Agent Workflows, because an OpenWorkflow worker runs the Agent turns. */
export function registersAgentWorkflows(workflow: false | ResolvedWorkflowOptions | undefined): boolean {
  return workflow !== undefined && workflow !== false && workflow.driver === "openworkflow"
}

/**
 * `dev` turns on the run history of `vite dev`. A build that installs the registry at startup passes `false`.
 * With OpenWorkflow, the plugin also loads OpenWorkflow from the server bundle and starts its worker in this server
 * unless `workflow.worker` is `false`.
 */
export function createWorkflowDevPluginModule(workflow: false | ResolvedWorkflowOptions | undefined, dev = false, databaseImport?: string): string {
  if (workflow === undefined) return "export default function viteHubWorkflowStartupPlugin() {}\n"
  const openWorkflow = workflow !== false && workflow.driver === "openworkflow"
  const runtimeConfig = dev && workflow !== false ? localDevWorkflowOptions(workflow) : workflow
  return [
    "import { definePlugin } from \"nitro\"",
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(workflowRuntimeModule("state"))}`,
    ...(dev ? [`import { enableWorkflowDevRuns } from ${JSON.stringify(workflowRuntimeModule("dev-runs"))}`] : []),
    ...(openWorkflow ? [`import { installOpenWorkflow } from ${JSON.stringify(workflowRuntimeModule("openworkflow-worker"))}`] : []),
    ...(openWorkflow && databaseImport ? [`import { getPostgresConnectionUrl } from ${JSON.stringify(databaseImport)}`] : []),
    `import registry from ${JSON.stringify(`./${devRegistryFile}`)}`,
    "",
    `export default definePlugin((${openWorkflow ? "nitroApp" : ""}) => {`,
    `  setWorkflowRuntimeConfig(${JSON.stringify(runtimeConfig)})`,
    "  setWorkflowRuntimeRegistry(registry)",
    ...(dev ? ["  enableWorkflowDevRuns()"] : []),
    ...(openWorkflow ? [databaseImport
      ? "  installOpenWorkflow(nitroApp, { databaseUrl: () => getPostgresConnectionUrl(\"default\") })"
      : "  installOpenWorkflow(nitroApp)"] : []),
    "})",
    "",
  ].join("\n")
}

/**
 * On Vercel, Nitro's server function runs the routes, so its startup plugin installs the Workflow registry of the
 * Vercel build. `waitUntil` keeps the function alive while an inline run works after the response.
 */
export function createWorkflowVercelNitroPluginModule(pluginFile: string, vercel: WorkflowVercelNitroRegistry, workflow: ResolvedWorkflowOptions): string {
  return [
    "import { definePlugin } from \"nitro\"",
    "import { waitUntil } from \"@vercel/functions\"",
    `import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(workflowRuntimeModule("state"))}`,
    ...(vercel.native
      ? [
          `import { setVercelWorkflowRuntimeModules } from ${JSON.stringify(workflowRuntimeModule("vercel-vite"))}`,
          "import * as workflowApi from \"workflow/api\"",
          "import * as workflowRuntime from \"workflow/runtime\"",
        ]
      : []),
    `import registry from ${JSON.stringify(createImportPath(pluginFile, vercel.registryFile))}`,
    "",
    "export default definePlugin(() => {",
    ...(vercel.native ? ["  setVercelWorkflowRuntimeModules(workflowApi, workflowRuntime)"] : []),
    `  setWorkflowRuntimeConfig(${JSON.stringify(workflow)})`,
    "  setWorkflowRuntimeRegistry(registry)",
    "  enterWorkflowRuntimeEvent({ waitUntil })",
    "})",
    "",
  ].join("\n")
}

/** The Workflow registry that a Nitro build for Vercel installs instead of the development registry. */
export interface WorkflowVercelNitroRegistry {
  /** True when a definition has a `native` entry. The plugin then gives the Workflow DevKit modules to the runtime. */
  native: boolean
  registryFile: string
}

function localDevWorkflowOptions(workflow: ResolvedWorkflowOptions): ResolvedWorkflowOptions {
  if (workflow.driver !== "openworkflow" || workflow.remote === true) return workflow
  if (workflow.postgres?.url !== undefined || workflow.sqlite?.path !== undefined) return workflow
  return { ...workflow, sqlite: { ...workflow.sqlite, path: defaultOpenWorkflowSqlitePath } }
}

async function writeIfChanged(file: string, contents: string): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => undefined)
  if (current === contents) return false
  await writeFile(file, contents, "utf8")
  return true
}

export interface WorkflowDevRegistryFilesOptions {
  /** The Agent files that Agent Workflow entries import. Without them, the Agent package that the app installs. */
  agentModules?: AgentWorkflowModules
  /** The module that exports `getPostgresConnectionUrl()`, when the app has a Postgres Default Database. */
  databaseImport?: string
  definitions: DiscoveredWorkflowDefinition[]
  /** Install generated Agent State and Capability loaders before workers start. */
  transformRegistry?: (code: string, id: string) => string | Promise<string>
  /** True in `vite dev`: the plugin turns on the run history. */
  dev?: boolean
  importBase?: string
  projectRoot: string
  /** Retain the startup path Nitro read before final Vite configuration. */
  pluginPath?: string
  /** Undefined reserves an inert bootstrap until the final build configuration is known. */
  workflow: false | ResolvedWorkflowOptions | undefined
  /** A Nitro build for Vercel installs this registry. */
  vercel?: WorkflowVercelNitroRegistry
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
  let registryContents = createWorkflowRegistryContents(registry, options.definitions, {
    agent: options.definitions.some(definition => definition.source === "agent-workflow")
      ? options.agentModules ?? await installedAgentWorkflowModules(options.projectRoot)
      : undefined,
    workflow: options.importBase,
  })
  if (options.transformRegistry) registryContents = await options.transformRegistry(registryContents, registry)
  const files: Array<[string, string]> = [
    [registry, registryContents],
    [plugin, options.vercel && options.workflow
      ? createWorkflowVercelNitroPluginModule(plugin, options.vercel, options.workflow)
      : createWorkflowDevPluginModule(options.workflow, options.dev, options.databaseImport)],
  ]
  if (process.env.VITEST) {
    files.push([resolve(directory, workflowTestSetupFile), [
      `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(workflowRuntimeModule("state"))}`,
      `import registry from "./${devRegistryFile}"`,
      `setWorkflowRuntimeConfig(${JSON.stringify(options.workflow ?? false)})`,
      "setWorkflowRuntimeRegistry(registry)",
      "",
    ].join("\n")])
  }
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
