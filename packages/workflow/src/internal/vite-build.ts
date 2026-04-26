import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { copyClientOutput, hasStaticIndex } from "@vitehub/internal/build/client-output"
import { bundleEsmEntry } from "@vitehub/internal/build/esbuild"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vitehub/internal/build/paths"
import { resolveUserAppEntry, toSafeAppName } from "@vitehub/internal/build/user-entry"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vitehub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vitehub/internal/definition-discovery"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { getCloudflareWorkflowBindingName, getCloudflareWorkflowClassName, getCloudflareWorkflowName } from "../integrations/cloudflare.ts"

import type { DiscoveredWorkflowDefinition, WorkflowModuleOptions, WorkflowProvider } from "../types.ts"

export const workflowPackageName = "@vitehub/workflow"
const defaultCompatibilityDate = "2026-04-20"
const productName = "workflow"

const generatedRegistryFileName = "registry.mjs"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)
const WORKFLOW_ENTRY_NAMES_DEFAULT = ["server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"] as const
const WORKFLOW_ENTRY_NAMES_PRIORITIZED = ["server-workflow.ts", "server-workflow.mts", "server-workflow.js", "server-workflow.mjs", ...WORKFLOW_ENTRY_NAMES_DEFAULT] as const

function resolveWorkflowUserAppEntry(rootDir: string) {
  const names = process.env.VITEHUB_VITE_MODE === "workflow" ? WORKFLOW_ENTRY_NAMES_PRIORITIZED : WORKFLOW_ENTRY_NAMES_DEFAULT
  return resolveUserAppEntry(rootDir, { names })
}

interface ProviderEntrySpec {
  name: WorkflowProvider
  entryFile: string
  runtimeModule: string
  factory: string
  hosting: string
}

const providerEntrySpecs: ProviderEntrySpec[] = [
  { name: "cloudflare", entryFile: "cloudflare-worker.mjs", runtimeModule: "runtime/cloudflare-vite", factory: "createWorkflowCloudflareWorker", hosting: "cloudflare" },
  { name: "vercel", entryFile: "vercel-server.mjs", runtimeModule: "runtime/vercel-vite", factory: "createWorkflowVercelServer", hosting: "vercel" },
]

interface GeneratedWorkflowArtifacts {
  cloudflareWorkerFile: string
  definitions: DiscoveredWorkflowDefinition[]
  generatedDir: string
  registryFile: string
  vercelServerFile: string
}

interface GenerateProviderOutputsOptions {
  clientOutDir: string
  rootDir: string
  workflow: WorkflowModuleOptions | undefined
}

interface CloudflareWorkflowConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  main: string
  name?: string
  observability: { enabled: true }
  workflows?: Array<{ binding: string, class_name: string, name: string }>
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

function renderCloudflareWorkflowRunner(workflowConfig: unknown) {
  return [
    "export async function runViteHubWorkflowDefinition(name, env, event, step) {",
    `    setWorkflowRuntimeConfig(${JSON.stringify(workflowConfig, null, 2)})`,
    `    setWorkflowRuntimeRegistry(workflowRegistry)`,
    "    setActiveCloudflareEnv(env || {})",
    "    const definition = await loadWorkflowDefinition(name)",
    "    if (!definition) throw new Error('Missing workflow definition.')",
    `    return await runWithWorkflowRuntimeEvent({ env, step }, () => definition.handler({`,
    `      id: event?.instanceId || event?.id,`,
    `      name,`,
    `      payload: event?.payload,`,
    `      provider: "cloudflare",`,
    `      step,`,
    `    }))`,
    "}",
    "",
  ].join("\n")
}

function renderCloudflareWorkerWrapper(definitions: DiscoveredWorkflowDefinition[]) {
  return [
    `import { WorkflowEntrypoint, waitUntil as viteHubWaitUntil } from "cloudflare:workers"`,
    `import worker, { runViteHubWorkflowDefinition } from "./worker.mjs"`,
    "",
    ...definitions.map((definition) => {
      const className = getCloudflareWorkflowClassName(definition.name)
      return [
        `export class ${className} extends WorkflowEntrypoint {`,
        "  async run(event, step) {",
        `    return await runViteHubWorkflowDefinition(${JSON.stringify(definition.name)}, this.env || {}, event, step)`,
        "  }",
        "}",
        "",
      ].join("\n")
    }),
    "const viteHubWorker = {",
    "  async fetch(request, env, context) {",
    "    const waitUntil = typeof viteHubWaitUntil === \"function\" ? viteHubWaitUntil : context?.waitUntil?.bind(context)",
    "    return await worker.fetch(request, env, waitUntil ? { ...context, waitUntil } : context)",
    "  }",
    "}",
    "",
    "export default viteHubWorker",
    "",
  ].flat().join("\n")
}

function renderProviderEntry(
  spec: ProviderEntrySpec,
  entryFile: string,
  registryFile: string,
  definitions: DiscoveredWorkflowDefinition[],
  userAppEntry: string | undefined,
  workflowConfig: unknown,
) {
  const imports = [
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
    `import workflowRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
  ]
  if (spec.name === "cloudflare") {
    imports.push(`import { setActiveCloudflareEnv } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("runtime/cloudflare-shared")))}`)
    imports.push(`import { loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("runtime/state")))}`)
  }
  if (userAppEntry) {
    imports.push(`import workflowApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  return [
    ...imports,
    "",
    ...(spec.name === "cloudflare"
      ? [renderCloudflareWorkflowRunner(workflowConfig)]
      : []),
    `const workflowConfig = ${JSON.stringify(workflowConfig, null, 2)}`,
    "",
    `export default ${spec.factory}({`,
    userAppEntry ? "  app: workflowApp," : "",
    "  registry: workflowRegistry,",
    "  workflow: workflowConfig,",
    "})",
    "",
  ].flat().filter(Boolean).join("\n")
}

async function writeProviderEntries(rootDir: string, workflow: WorkflowModuleOptions | undefined) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverWorkflowDefinitions({ rootDir })
  const userAppEntry = resolveWorkflowUserAppEntry(rootDir)

  await writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8")

  const entryFiles: Record<WorkflowProvider, string> = { cloudflare: "", vercel: "" }
  for (const spec of providerEntrySpecs) {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const workflowConfig = normalizeWorkflowOptions(workflow, { hosting: spec.hosting }) || false
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, registryFile, definitions, userAppEntry, workflowConfig), "utf8")
    entryFiles[spec.name] = entryFile
  }

  return {
    cloudflareWorkerFile: entryFiles.cloudflare,
    definitions,
    generatedDir,
    registryFile,
    vercelServerFile: entryFiles.vercel,
  }
}

async function writeCloudflareOutput(rootDir: string, clientOutDir: string, artifacts: GeneratedWorkflowArtifacts) {
  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, "dist", toSafeAppName(rootDir))
  const workerOutfile = resolve(outputRoot, "worker.mjs")
  const staticIndex = hasStaticIndex(clientDir)
  const workflows = createCloudflareWorkflowBindings(artifacts.definitions)

  await rm(outputRoot, { force: true, recursive: true })
  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(rootDir, "dist", "client"))
  }

  await mkdir(outputRoot, { recursive: true })

  await bundleEsmEntry(artifacts.cloudflareWorkerFile, workerOutfile, {
    conditions: ["workerd", "worker", "browser", "default"],
    external: [
      "@cloudflare/sandbox",
      "@vercel/blob",
      "@vercel/functions",
      "@vercel/queue",
      "@vercel/sandbox",
      "cloudflare:workers",
      "node:async_hooks",
      "workflow",
      "workflow/api",
      "workflow/runtime",
    ],
    format: "esm",
    platform: "neutral",
  })
  await writeFile(resolve(outputRoot, "index.js"), renderCloudflareWorkerWrapper(artifacts.definitions), "utf8")

  const wranglerConfig: CloudflareWorkflowConfig = {
    compatibility_date: defaultCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    name: toSafeAppName(rootDir),
    observability: { enabled: true },
    ...(staticIndex ? { assets: { directory: "../client", run_worker_first: ["/api/*"] } } : {}),
    ...(workflows ? { workflows } : {}),
  }

  await writeFile(resolve(outputRoot, "wrangler.json"), `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8")
}

async function writeVercelOutput(rootDir: string, clientOutDir: string, artifacts: GeneratedWorkflowArtifacts) {
  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const serverDir = resolve(outputRoot, "functions", "__server.func")
  const serverEntry = resolve(serverDir, "index.mjs")
  const staticIndex = hasStaticIndex(clientDir)

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await bundleEsmEntry(artifacts.vercelServerFile, serverEntry, {
    external: ["@cloudflare/sandbox", "cloudflare:workers", "workflow", "workflow/api", "workflow/runtime"],
    format: "esm",
    platform: "node",
  })

  await writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  await writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(createVercelConfigJson(), null, 2)}\n`, "utf8")

  if (staticIndex) {
    await copyClientOutput(clientDir, resolve(outputRoot, "static"))
  }
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedWorkflowArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.workflow)
  await writeCloudflareOutput(options.rootDir, options.clientOutDir, artifacts)
  await writeVercelOutput(options.rootDir, options.clientOutDir, artifacts)
  return artifacts
}
