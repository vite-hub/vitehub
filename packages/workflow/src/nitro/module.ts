import { createImportPath } from "@vitehub/internal/build/paths"
import { createRuntimeRegistryContents, writeFileIfChanged } from "@vitehub/internal/definition-discovery"
import { resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"
import { resolve } from "node:path"
import type { NitroModule, NitroOptions, NitroRuntimeConfig } from "nitro/types"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { getCloudflareWorkflowBindingName, getCloudflareWorkflowClassName, getCloudflareWorkflowName } from "../integrations/cloudflare.ts"
import type { DiscoveredWorkflowDefinition, WorkflowModuleOptions } from "../types.ts"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function createCloudflareWorkflowBindings(definitions: DiscoveredWorkflowDefinition[]) {
  if (!definitions.length) {
    return undefined
  }

  return definitions.map(definition => ({
    binding: getCloudflareWorkflowBindingName(definition.name),
    class_name: getCloudflareWorkflowClassName(definition.name),
    name: getCloudflareWorkflowName(definition.name),
  }))
}

function mergeWorkflowImports(current: NitroOptions["imports"]) {
  if (current === false) {
    return current
  }

  const imports = ["createWorkflow", "deferWorkflow", "defineWorkflow", "getWorkflowRun", "runWorkflow"]
  const existing = current || {}
  const currentPresets = (Array.isArray(existing.presets) ? [...existing.presets] : []) as Array<{ from?: string, imports?: string[] }>
  const workflowPreset = currentPresets.find(entry => entry?.from === "@vitehub/workflow")

  if (workflowPreset && Array.isArray(workflowPreset.imports)) {
    const seen = new Set(workflowPreset.imports)
    workflowPreset.imports.push(...imports.filter(name => !seen.has(name)))
  } else if (!workflowPreset) {
    currentPresets.push({
      from: "@vitehub/workflow",
      imports,
    })
  }

  return {
    ...existing,
    presets: currentPresets,
  }
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
    "import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from \"@vitehub/workflow/runtime/state\"",
    "",
    `import workflowRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    "const workflowNitroPlugin = defineNitroPlugin((nitroApp) => {",
    "  const runtimeConfig = useRuntimeConfig()",
    "  const applyRuntimeState = () => {",
    "    setWorkflowRuntimeConfig(runtimeConfig.workflow)",
    "    setWorkflowRuntimeRegistry(workflowRegistry)",
    "  }",
    "",
    "  applyRuntimeState()",
    "  nitroApp.hooks.hook(\"request\", (event) => {",
    "    applyRuntimeState()",
    "    enterWorkflowRuntimeEvent(event)",
    "  })",
    "})",
    "",
    "export default workflowNitroPlugin",
    "",
  ].join("\n")
}

async function writeNitroWorkflowRuntimeFiles(nitro: { options: { buildDir: string, rootDir: string, scanDirs: string[] } }) {
  const registryFile = createNitroWorkflowRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const pluginFile = createNitroWorkflowPluginPath(nitro.options.rootDir, nitro.options.buildDir)
  const definitions = discoverWorkflowDefinitions({
    mode: "nitro-server-workflows",
    scanDirs: resolveNitroWorkflowScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  await writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions))
  await writeFileIfChanged(pluginFile, createNitroWorkflowPluginContents(pluginFile, registryFile))

  return {
    definitions,
    pluginFile,
    registryFile,
  }
}

const workflowNitroModule: NitroModule = {
  name: "@vitehub/workflow",
  async setup(nitro: any) {
    const resolved = normalizeWorkflowOptions(nitro.options.workflow, {
      hosting: nitro.options.preset,
    })
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.workflow = resolved || false

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/workflow"] = resolveRuntimeEntry("../index", "@vitehub/workflow")
    nitro.options.alias["@vitehub/workflow/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/workflow/runtime/state")

    let runtimeFiles = await writeNitroWorkflowRuntimeFiles(nitro)
    nitro.options.alias["#vitehub/workflow/registry"] = runtimeFiles.registryFile
    const { definitions } = runtimeFiles

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeWorkflowImports(nitro.options.imports === false ? {} : nitro.options.imports)
    }

    if (!resolved) {
      return
    }

    nitro.options.plugins ||= []
    const plugin = runtimeFiles.pluginFile
    if (!nitro.options.plugins.includes(plugin)) {
      nitro.options.plugins.push(plugin)
    }

    const workflows = createCloudflareWorkflowBindings(definitions)
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
    workflow?: false | ReturnType<typeof normalizeWorkflowOptions>
  }
}
