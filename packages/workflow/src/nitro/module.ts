import { appendFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { createRuntimeRegistryContents, writeFileIfChanged } from "@vitehub/internal/definition-discovery"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../integrations/cloudflare.ts"
import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions, WorkflowModuleOptions } from "../types.ts"

const WORKFLOW_NITRO_IMPORTS_PRESET = { from: "@vitehub/workflow", imports: ["createWorkflow", "deferWorkflow", "defineWorkflow", "getWorkflowRun", "runWorkflow"] }

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function createNitroWorkflowRegistryPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, "vitehub", "workflow", "nitro-registry.mjs")
}

function createNitroWorkflowPluginPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, "vitehub", "workflow", "nitro-plugin.ts")
}

function resolveNitroWorkflowScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

function createNitroWorkflowPluginContents(file: string, registryFile: string) {
  return [
    "import { definePlugin as defineNitroPlugin } from \"nitro\"",
    "import { useRuntimeConfig } from \"nitro/runtime-config\"",
    "",
    "import { runCloudflareWorkflow } from \"@vitehub/workflow/runtime/cloudflare-runner\"",
    "import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from \"@vitehub/workflow/runtime/state\"",
    "",
    `import workflowRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    "export async function runNitroWorkflowDefinition(name, env, event, step) {",
    "  const runtimeConfig = useRuntimeConfig()",
    "  return await runCloudflareWorkflow({ config: runtimeConfig.workflow, env: env || {}, event, name, registry: workflowRegistry, step })",
    "}",
    "",
    "globalThis.__vitehubRunNitroWorkflowDefinition = runNitroWorkflowDefinition",
    "",
    "const workflowNitroPlugin = defineNitroPlugin((nitroApp) => {",
    "  const runtimeConfig = useRuntimeConfig()",
    "  setWorkflowRuntimeConfig(runtimeConfig.workflow)",
    "  setWorkflowRuntimeRegistry(workflowRegistry)",
    "",
    "  nitroApp.hooks.hook(\"request\", (event) => {",
    "    enterWorkflowRuntimeEvent(event)",
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

interface RuntimeFiles { definitions: DiscoveredWorkflowDefinition[], pluginFile: string, registryFile: string }

async function writeNitroWorkflowRuntimeFiles(nitro: Nitro): Promise<RuntimeFiles> {
  const registryFile = createNitroWorkflowRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const pluginFile = createNitroWorkflowPluginPath(nitro.options.rootDir, nitro.options.buildDir)
  const definitions = discoverWorkflowDefinitions({
    mode: "nitro-server-workflows",
    scanDirs: resolveNitroWorkflowScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  await Promise.all([
    writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
    writeFileIfChanged(pluginFile, createNitroWorkflowPluginContents(pluginFile, registryFile)),
  ])

  return { definitions, pluginFile, registryFile }
}

const workflowNitroModule: NitroModule = {
  name: "@vitehub/workflow",
  async setup(nitro) {
    const resolved = normalizeWorkflowOptions(nitro.options.workflow, { hosting: nitro.options.preset })
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.workflow = resolved || false

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/workflow"] = resolveRuntimeEntry("../index", "@vitehub/workflow")
    nitro.options.alias["@vitehub/workflow/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/workflow/runtime/state")
    nitro.options.alias["@vitehub/workflow/runtime/cloudflare-runner"] = resolveRuntimeEntry("../runtime/cloudflare-runner", "@vitehub/workflow/runtime/cloudflare-runner")

    let runtimeFiles = await writeNitroWorkflowRuntimeFiles(nitro)
    nitro.options.alias["#vitehub/workflow/registry"] = runtimeFiles.registryFile

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

    const workflows = createCloudflareWorkflowBindings(runtimeFiles.definitions, resolved)
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

    nitro.hooks.hook("build:before", async () => {
      runtimeFiles = await writeNitroWorkflowRuntimeFiles(nitro)
    })
    nitro.hooks.hook("dev:reload", async () => {
      runtimeFiles = await writeNitroWorkflowRuntimeFiles(nitro)
    })
    nitro.hooks.hook("compiled", async (currentNitro) => {
      if (!currentNitro.options.preset?.includes("cloudflare")) {
        return
      }
      const classExports = createCloudflareWorkflowClassExports(runtimeFiles.definitions)
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
