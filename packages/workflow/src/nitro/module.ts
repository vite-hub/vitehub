import { appendFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { applyNitroRuntimeAliases, createNitroRuntimeFilePath, hookNitroRuntimeRegistryRefresh, writeRuntimeRegistryFiles } from "@vite-hub/internal/definition-catalog"
import { assertNoVitePluginInNitro, mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vite-hub/internal/nitro"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../integrations/cloudflare.ts"
import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions, WorkflowModuleOptions, WorkflowRuntimeConfigValue } from "../types.ts"

const WORKFLOW_NITRO_IMPORTS_PRESET = { from: "@vite-hub/workflow", imports: ["defineWorkflow", "getWorkflowRun"] }
const OPENWORKFLOW_POSTGRES_NITRO_TRACE_DEPS = ["openworkflow", "postgres"] as const
const OPENWORKFLOW_POSTGRES_NITRO_TRACE_IMPORTS = ["openworkflow", "openworkflow/postgres"] as const
const OPENWORKFLOW_SQLITE_NITRO_TRACE_DEPS = ["openworkflow"] as const
const OPENWORKFLOW_SQLITE_NITRO_TRACE_IMPORTS = ["openworkflow", "openworkflow/sqlite"] as const
const WORKFLOW_VITE_PLUGIN_NAME = "@vite-hub/workflow/vite"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function createNitroWorkflowRegistryPath(rootDir: string, buildDir: string) {
  return createNitroRuntimeFilePath(rootDir, {
    buildDir,
    fileName: "nitro-registry.mjs",
    segments: ["vitehub", "workflow"],
  })
}

function createNitroWorkflowPluginPath(rootDir: string, buildDir: string) {
  return createNitroRuntimeFilePath(rootDir, {
    buildDir,
    fileName: "nitro-plugin.ts",
    segments: ["vitehub", "workflow"],
  })
}

function resolveNitroWorkflowScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

function createNitroWorkflowPluginContents(file: string, registryFile: string, options: false | ResolvedWorkflowOptions) {
  const openWorkflowTraceImports = options && options.provider === "openworkflow"
    ? getOpenWorkflowNitroTraceImports(options).map(specifier => `import ${JSON.stringify(specifier)}`)
    : []

  return [
    "import { definePlugin as defineNitroPlugin } from \"nitro\"",
    "import { useRuntimeConfig } from \"nitro/runtime-config\"",
    "",
    "import { runCloudflareWorkflow } from \"@vite-hub/workflow/runtime/cloudflare-runner\"",
    "import { startOpenWorkflowWorker } from \"@vite-hub/workflow/runtime/openworkflow-worker\"",
    "import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from \"@vite-hub/workflow/runtime/state\"",
    ...openWorkflowTraceImports,
    "",
    `import workflowRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    "function applyWorkflowRuntimeEnv(runtimeConfig, env) {",
    "  globalThis.__vitehubApplyRuntimeEnvToRuntimeConfig?.(runtimeConfig, { env: env || {} })",
    "}",
    "",
    "export async function runNitroWorkflowDefinition(name, env, event, step) {",
    "  const runtimeConfig = useRuntimeConfig()",
    "  applyWorkflowRuntimeEnv(runtimeConfig, env)",
    "  return await runCloudflareWorkflow({ config: runtimeConfig.workflow, env: env || {}, event, name, registry: workflowRegistry, step })",
    "}",
    "",
    "globalThis.__vitehubRunNitroWorkflowDefinition = runNitroWorkflowDefinition",
    "",
    "function shouldStartOpenWorkflowWorker(workflowConfig) {",
    "  return workflowConfig?.provider === \"openworkflow\" && hasOpenWorkflowStorageConfig(workflowConfig) && globalThis.process?.env?.OPENWORKFLOW_WORKER !== \"false\"",
    "}",
    "",
    "function hasOpenWorkflowStorageConfig(workflowConfig) {",
    "  return Boolean(workflowConfig?.sqlite?.path || workflowConfig?.postgres?.url || globalThis.process?.env?.OPENWORKFLOW_SQLITE_PATH || globalThis.process?.env?.OPENWORKFLOW_POSTGRES_URL || globalThis.process?.env?.DATABASE_URL)",
    "}",
    "",
    "const workflowNitroPlugin = defineNitroPlugin(async (nitroApp) => {",
    "  const runtimeConfig = useRuntimeConfig()",
    "  setWorkflowRuntimeConfig(runtimeConfig.workflow)",
    "  setWorkflowRuntimeRegistry(workflowRegistry)",
    "",
    "  nitroApp.hooks.hook(\"request\", (event) => {",
    "    enterWorkflowRuntimeEvent(event)",
    "  })",
    "",
    "  if (!shouldStartOpenWorkflowWorker(runtimeConfig.workflow)) {",
    "    return",
    "  }",
    "",
    "  const worker = await startOpenWorkflowWorker({",
    "    config: runtimeConfig.workflow,",
    "    concurrency: Number(globalThis.process?.env?.OPENWORKFLOW_WORKER_CONCURRENCY || runtimeConfig.workflow.worker?.concurrency || 10),",
    "    registry: workflowRegistry,",
    "    signals: false,",
    "  })",
    "",
    "  let stopped = false",
    "  nitroApp.hooks.hook(\"close\", async () => {",
    "    if (stopped) {",
    "      return",
    "    }",
    "    stopped = true",
    "    await worker.stop()",
    "  })",
    "})",
    "",
    "export default workflowNitroPlugin",
    "",
  ].join("\n")
}

function createCloudflareWorkflowClassExports(definitions: DiscoveredWorkflowDefinition[]) {
  if (!definitions.length) {
    return ""
  }

  return [
    "",
    "import { WorkflowEntrypoint as ViteHubWorkflowEntrypoint } from \"cloudflare:workers\"",
    "",
    ...definitions.map((definition) => {
      const className = getCloudflareWorkflowClassName(definition.name)
      return [
        `export class ${className} extends ViteHubWorkflowEntrypoint {`,
        "  async run(event, step) {",
        `    return await globalThis.__vitehubRunNitroWorkflowDefinition(${JSON.stringify(definition.name)}, this.env || {}, event, step)`,
        "  }",
        "}",
        "",
      ].join("\n")
    }),
  ].flat().join("\n")
}

interface RuntimeFiles { definitions: DiscoveredWorkflowDefinition[], pluginFile: string, providerDefinitions: DiscoveredWorkflowDefinition[], registryFile: string }

async function writeNitroWorkflowRuntimeFiles(nitro: Nitro, resolved: false | ResolvedWorkflowOptions): Promise<RuntimeFiles> {
  const registryFile = createNitroWorkflowRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const pluginFile = createNitroWorkflowPluginPath(nitro.options.rootDir, nitro.options.buildDir)
  const definitions = discoverWorkflowDefinitions({
    mode: "nitro-server-workflows",
    scanDirs: resolveNitroWorkflowScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })
  const providerDefinitions = definitions

  const runtimeFiles = await writeRuntimeRegistryFiles({
    createPluginContents: (file, registryFile) => createNitroWorkflowPluginContents(file, registryFile, resolved),
    definitions,
    pluginFile,
    registryFile,
  })

  return { ...runtimeFiles, providerDefinitions }
}

function getOpenWorkflowNitroTraceDeps(options: ResolvedWorkflowOptions) {
  return options.provider === "openworkflow" && options.sqlite?.path
    ? OPENWORKFLOW_SQLITE_NITRO_TRACE_DEPS
    : OPENWORKFLOW_POSTGRES_NITRO_TRACE_DEPS
}

function getOpenWorkflowNitroTraceImports(options: ResolvedWorkflowOptions) {
  return options.provider === "openworkflow" && options.sqlite?.path
    ? OPENWORKFLOW_SQLITE_NITRO_TRACE_IMPORTS
    : OPENWORKFLOW_POSTGRES_NITRO_TRACE_IMPORTS
}

function normalizeDatabaseSqlitePath(url: string, name: string): string {
  if (url === ":memory:") return url
  if (/^(?:libsql:|https?:\/\/)/i.test(url)) {
    throw new Error(`[vitehub] workflow.database "${name}" uses ${JSON.stringify(url)}, but OpenWorkflow SQLite storage requires a local SQLite file path.`)
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("file:")) {
    throw new Error(`[vitehub] workflow.database "${name}" uses unsupported OpenWorkflow storage URL ${JSON.stringify(url)}.`)
  }
  return url.startsWith("file:") ? url.slice("file:".length) : url
}

function normalizeDatabaseSqliteConfigValue(value: WorkflowRuntimeConfigValue, name: string, resolvedUrl: string): WorkflowRuntimeConfigValue {
  const normalizedResolvedUrl = normalizeDatabaseSqlitePath(resolvedUrl, name)
  if (typeof value === "string") return normalizedResolvedUrl
  if (typeof value.default !== "string") return value
  return {
    ...value,
    default: normalizeDatabaseSqlitePath(value.default, name),
  }
}

function isPostgresDatabaseUrl(url: string): boolean {
  return /^postgres(?:ql)?:/i.test(url)
}

async function resolveOpenWorkflowDatabaseStorage(rootDir: string, options: false | ResolvedWorkflowOptions): Promise<false | ResolvedWorkflowOptions> {
  if (!options || options.provider !== "openworkflow" || !options.database) {
    return options
  }

  const databaseName = options.database
  let databaseModule: {
    resolveConfigValue: (value: unknown) => string | undefined
    resolveDBViteConfig: (options?: unknown, rootDir?: string) => { databases: Record<string, { connection?: { authToken?: unknown, url?: WorkflowRuntimeConfigValue }, dialect: string }> } | undefined
  }
  try {
    databaseModule = await import("@vite-hub/database/config") as typeof databaseModule
  }
  catch (error) {
    throw new Error(`[vitehub] workflow.database requires @vite-hub/database. Install @vite-hub/database and add a Database Definition named "${databaseName}".`, { cause: error })
  }

  const config = databaseModule.resolveDBViteConfig(undefined, rootDir)
  const database = config?.databases[databaseName]
  if (!database) {
    throw new Error(`[vitehub] workflow.database references missing Database Definition "${databaseName}".`)
  }

  const url = database.connection?.url
  const resolvedUrl = databaseModule.resolveConfigValue(url)
  if (!url || !resolvedUrl) {
    throw new Error(`[vitehub] workflow.database "${databaseName}" requires a database connection URL.`)
  }

  if (isPostgresDatabaseUrl(resolvedUrl)) {
    return {
      ...options,
      postgres: {
        ...options.postgres,
        url,
      },
    }
  }

  if (typeof database.connection?.authToken !== "undefined") {
    throw new Error(`[vitehub] workflow.database "${databaseName}" has an auth token, but OpenWorkflow SQLite storage only supports local SQLite files.`)
  }

  return {
    ...options,
    sqlite: {
      ...options.sqlite,
      path: normalizeDatabaseSqliteConfigValue(url, databaseName, resolvedUrl),
    },
  }
}

function addOpenWorkflowNitroTraceDeps(nitro: Nitro, resolved: ResolvedWorkflowOptions): void {
  const options = nitro.options as typeof nitro.options & { traceDeps?: string[] }
  options.traceDeps ||= []
  for (const dependency of getOpenWorkflowNitroTraceDeps(resolved)) {
    if (!options.traceDeps.includes(dependency)) {
      options.traceDeps.push(dependency)
    }
  }
}

const workflowNitroModule: NitroModule = {
  name: "@vite-hub/workflow",
  async setup(nitro) {
    await assertNoVitePluginInNitro(nitro, WORKFLOW_VITE_PLUGIN_NAME, "@vite-hub/workflow/nitro")

    const normalized = normalizeWorkflowOptions(nitro.options.workflow, { hosting: nitro.options.preset })
    const resolved = await resolveOpenWorkflowDatabaseStorage(nitro.options.rootDir, normalized || false)
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.workflow = resolved || false

    nitro.options.alias ||= {}
    nitro.options.alias["@vite-hub/workflow"] = resolveRuntimeEntry("../index", "@vite-hub/workflow")
    nitro.options.alias["@vite-hub/workflow/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vite-hub/workflow/runtime/state")
    nitro.options.alias["@vite-hub/workflow/runtime/execute"] = resolveRuntimeEntry("../runtime/execute", "@vite-hub/workflow/runtime/execute")
    nitro.options.alias["@vite-hub/workflow/runtime/cloudflare-runner"] = resolveRuntimeEntry("../runtime/cloudflare-runner", "@vite-hub/workflow/runtime/cloudflare-runner")
    nitro.options.alias["@vite-hub/workflow/runtime/openworkflow"] = resolveRuntimeEntry("../runtime/openworkflow", "@vite-hub/workflow/runtime/openworkflow")
    nitro.options.alias["@vite-hub/workflow/runtime/openworkflow-worker"] = resolveRuntimeEntry("../runtime/openworkflow-worker", "@vite-hub/workflow/runtime/openworkflow-worker")

    if (resolved && resolved.provider === "openworkflow") {
      addOpenWorkflowNitroTraceDeps(nitro, resolved)
    }

    let runtimeFiles = await writeNitroWorkflowRuntimeFiles(nitro, resolved || false)
    applyNitroRuntimeAliases(nitro, { "#vitehub/workflow/registry": runtimeFiles.registryFile })

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, WORKFLOW_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
    }

    nitro.options.plugins ||= []
    if (!nitro.options.plugins.includes(runtimeFiles.pluginFile)) {
      nitro.options.plugins.push(runtimeFiles.pluginFile)
    }

    if (!resolved) {
      return
    }

    const workflows = resolved.provider === "cloudflare"
      ? createCloudflareWorkflowBindings(runtimeFiles.providerDefinitions, resolved)
      : undefined
    if (workflows && nitro.options.preset?.includes("cloudflare")) {
      nitro.options.cloudflare ||= {}
      nitro.options.cloudflare.wrangler ||= {}
      nitro.options.cloudflare.wrangler.workflows ||= []

      for (const workflow of workflows) {
        if (!nitro.options.cloudflare.wrangler.workflows.some((existing: { binding: string }) => existing.binding === workflow.binding)) {
          nitro.options.cloudflare.wrangler.workflows.push(workflow)
        }
      }
    }

    hookNitroRuntimeRegistryRefresh(nitro, () => writeNitroWorkflowRuntimeFiles(nitro, resolved || false), (nextRuntimeFiles) => {
      runtimeFiles = nextRuntimeFiles
      applyNitroRuntimeAliases(nitro, { "#vitehub/workflow/registry": runtimeFiles.registryFile })
    })
    nitro.hooks.hook("compiled", async (currentNitro) => {
      if (resolved.provider !== "cloudflare" || !currentNitro.options.preset?.includes("cloudflare")) {
        return
      }
      const classExports = createCloudflareWorkflowClassExports(runtimeFiles.providerDefinitions)
      if (!classExports) {
        return
      }
      await appendFile(join(currentNitro.options.output.serverDir, "index.mjs"), classExports, "utf8")
    })
  },
}

export default workflowNitroModule

declare module "nitro/types" {
  interface NitroConfig {
    workflow?: WorkflowModuleOptions
  }

  interface NitroOptions {
    workflow?: WorkflowModuleOptions
  }

  interface NitroRuntimeConfig {
    hosting?: string
    workflow?: false | ResolvedWorkflowOptions
  }
}
