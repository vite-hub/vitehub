import { mkdir, readFile, writeFile } from "node:fs/promises"
import { workflowRuntimeModule } from "./runtime-modules.ts"
import { dirname, relative, resolve } from "node:path"

import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createWorkflowRegistryContents, workflowPackageName } from "./vite-build.ts"

import { defaultOpenWorkflowSqlitePath } from "./openworkflow-defaults.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions } from "../types.ts"

// Provider servers install the discovered Workflow registry in production. In
// `vite dev`, and in builds for hosts without a Provider Output server (Node,
// Docker), the Vite plugin writes the registry and a Nitro plugin that installs
// it and the runtime config at startup.
export const workflowDevGeneratedDir = ".vitehub/nitro/workflow"
export const workflowTestSetupFile = "test-setup.mjs"
const devRegistryFile = "dev-registry.mjs"
const devPluginFile = "dev-plugin.mjs"

/**
 * Agent Workflows need the Agent registry transform of the provider build, so
 * the development registry does not contain them.
 */
function isWorkflowDevDefinition(definition: DiscoveredWorkflowDefinition): boolean {
  return definition.source !== "agent-workflow" && definition.source !== "agent-workflow-recovery"
}

export function discoverWorkflowDevDefinitions(rootDir: string, serverDirs?: string[]): DiscoveredWorkflowDefinition[] {
  return discoverWorkflowDefinitions({ mode: "standalone", rootDir, serverDirs })
}

function createWorkflowDevRegistryModule(registryFile: string, definitions: DiscoveredWorkflowDefinition[], importBase = workflowPackageName): string {
  return createWorkflowRegistryContents(registryFile, definitions.filter(isWorkflowDevDefinition), { workflow: importBase })
}

/**
 * `dev` turns on the run history of `vite dev`. A build that installs the registry at startup passes `false`.
 * With OpenWorkflow, the plugin also loads OpenWorkflow from the server bundle and starts its worker in this server
 * unless `workflow.worker` is `false`.
 */
export function createWorkflowDevPluginModule(workflow: false | ResolvedWorkflowOptions | undefined, dev = false, databaseImport?: string): string {
  // Provider Output builds own their registry; reserve a path without changing runtime state.
  if (workflow === undefined) return "export default function viteHubWorkflowStartupPlugin() {}\n"
  const openWorkflow = workflow !== false && workflow.provider === "openworkflow"
  const runtimeConfig = dev && workflow !== false ? localDevWorkflowOptions(workflow) : workflow
  return [
    "import { definePlugin } from \"nitro\"",
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(workflowRuntimeModule("state"))}`,
    // Only this import brings the run history into the app, so a build never includes it.
    ...(dev ? [`import { enableWorkflowDevRuns } from ${JSON.stringify(workflowRuntimeModule("dev-runs"))}`] : []),
    ...(openWorkflow ? [`import { installOpenWorkflow } from ${JSON.stringify(workflowRuntimeModule("openworkflow-worker"))}`] : []),
    ...(openWorkflow && databaseImport ? [`import { getPostgresConnectionUrl } from ${JSON.stringify(databaseImport)}`] : []),
    `import registry from ${JSON.stringify(`./${devRegistryFile}`)}`,
    "",
    `export default definePlugin((${openWorkflow ? "nitroApp" : ""}) => {`,
    `  setWorkflowRuntimeConfig(${JSON.stringify(runtimeConfig)})`,
    "  setWorkflowRuntimeRegistry(registry)",
    ...(dev ? ["  enableWorkflowDevRuns()"] : []),
    // OpenWorkflow reads the runtime config and registry, so it is installed after them.
    ...(openWorkflow ? [databaseImport
      ? "  installOpenWorkflow(nitroApp, { databaseUrl: () => getPostgresConnectionUrl(\"default\") })"
      : "  installOpenWorkflow(nitroApp)"] : []),
    "})",
    "",
  ].join("\n")
}

/**
 * `vite dev` stays local: without `remote: true` or configured storage, OpenWorkflow uses the local SQLite file, not
 * the Postgres of `DATABASE_URL` or `OPENWORKFLOW_POSTGRES_URL`. A dev server must not run the runs of a shared database
 * with local code.
 */
function localDevWorkflowOptions(workflow: ResolvedWorkflowOptions): ResolvedWorkflowOptions {
  if (workflow.provider !== "openworkflow" || workflow.remote === true) return workflow
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
  /** The module that exports `getPostgresConnectionUrl()`, when the app has a Postgres Default Database. */
  databaseImport?: string
  definitions: DiscoveredWorkflowDefinition[]
  /** True in `vite dev`: the plugin turns on the run history. */
  dev?: boolean
  importBase?: string
  projectRoot: string
  /** Retain the startup path Nitro read before final Vite configuration. */
  pluginPath?: string
  /** Undefined reserves an inert bootstrap until the final build configuration is known. */
  workflow: false | ResolvedWorkflowOptions | undefined
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
    [plugin, createWorkflowDevPluginModule(options.workflow, options.dev, options.databaseImport)],
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
