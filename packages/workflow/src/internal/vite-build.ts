import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { createDefaultCloudflareOutputRoot, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_MODES, getViteMode } from "@vite-hub/internal/build/mode"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../integrations/cloudflare.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions, WorkflowModuleOptions, WorkflowProvider } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"

export const workflowPackageName = "@vite-hub/workflow"
const productName = "workflow"

const generatedRegistryFileName = "registry.mjs"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)
const WORKFLOW_ENTRY_BASE_NAMES = ["server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"] as const
const WORKFLOW_PRIORITY_NAMES = ["server-workflow.ts", "server-workflow.mts", "server-workflow.js", "server-workflow.mjs"] as const

function resolveWorkflowUserAppEntry(rootDir: string) {
  const names = getViteMode() === VITEHUB_MODES.workflow
    ? [...WORKFLOW_PRIORITY_NAMES, ...WORKFLOW_ENTRY_BASE_NAMES]
    : [...WORKFLOW_ENTRY_BASE_NAMES]
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

function resolveWorkflowConfig(workflow: WorkflowModuleOptions | undefined, hosting: string): false | ResolvedWorkflowOptions {
  return normalizeWorkflowOptions(workflow, { hosting }) ?? false
}

interface GeneratedWorkflowArtifacts {
  cloudflareWorkerFile: string
  cloudflareWorkflowConfig: false | ResolvedWorkflowOptions
  definitions: DiscoveredWorkflowDefinition[]
  generatedDir: string
  providerDefinitions: DiscoveredWorkflowDefinition[]
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

function renderCloudflareWorkerWrapper(definitions: DiscoveredWorkflowDefinition[]) {
  return [
    definitions.length ? `import { WorkflowEntrypoint, waitUntil as viteHubWaitUntil } from "cloudflare:workers"` : `import { waitUntil as viteHubWaitUntil } from "cloudflare:workers"`,
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
  ].join("\n")
}

function renderProviderEntry(
  spec: ProviderEntrySpec,
  entryFile: string,
  userAppEntry: string | undefined,
  serializedWorkflowConfig: string,
) {
  const imports = [
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
    `import workflowRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
  ]
  if (spec.name === "cloudflare") {
    imports.push(`import { runCloudflareWorkflow } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("runtime/cloudflare-runner")))}`)
  }
  if (userAppEntry) {
    imports.push(`import workflowApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  const cloudflareDispatcher = spec.name === "cloudflare"
    ? [
        "",
        "export async function runViteHubWorkflowDefinition(name, env, event, step) {",
        "  return await runCloudflareWorkflow({ config: workflowConfig, env: env || {}, event, name, registry: workflowRegistry, step })",
        "}",
      ]
    : []

  return [
    ...imports,
    "",
    `const workflowConfig = ${serializedWorkflowConfig}`,
    ...cloudflareDispatcher,
    "",
    `export default ${spec.factory}({`,
    userAppEntry ? "  app: workflowApp," : "",
    "  registry: workflowRegistry,",
    "  workflow: workflowConfig,",
    "})",
    "",
  ].filter(Boolean).join("\n")
}

async function writeProviderEntries(rootDir: string, workflow: WorkflowModuleOptions | undefined) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverWorkflowDefinitions({ rootDir })
  const providerDefinitions = definitions
  const userAppEntry = resolveWorkflowUserAppEntry(rootDir)
  const cloudflareWorkflowConfig = resolveWorkflowConfig(workflow, "cloudflare")

  await writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8")

  const entryFiles: Record<WorkflowProvider, string> = { cloudflare: "", openworkflow: "", vercel: "" }
  await Promise.all(providerEntrySpecs.map(async (spec) => {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const workflowConfig = spec.name === "cloudflare"
      ? cloudflareWorkflowConfig
      : resolveWorkflowConfig(workflow, spec.hosting)
    const serialized = JSON.stringify(workflowConfig, null, 2)
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, userAppEntry, serialized), "utf8")
    entryFiles[spec.name] = entryFile
  }))

  return {
    cloudflareWorkerFile: entryFiles.cloudflare,
    cloudflareWorkflowConfig,
    definitions,
    generatedDir,
    providerDefinitions,
    registryFile,
    vercelServerFile: entryFiles.vercel,
  }
}

function createCloudflareOutput(rootDir: string, artifacts: GeneratedWorkflowArtifacts): CloudflareProviderDeploymentOutput {
  const workflowConfig = artifacts.cloudflareWorkflowConfig && artifacts.cloudflareWorkflowConfig.provider === "cloudflare"
    ? artifacts.cloudflareWorkflowConfig
    : false
  const workflowDefinitions = workflowConfig ? artifacts.providerDefinitions : []
  const workflows = createCloudflareWorkflowBindings(workflowDefinitions, workflowConfig)

  const wranglerConfig: CloudflareWorkflowConfig = {
    compatibility_date: defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    observability: { enabled: true },
    ...(workflows ? { workflows } : {}),
  }

  return {
    bundleEntry: artifacts.cloudflareWorkerFile,
    bundleOptions: {
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
    },
    bundleOutfileName: "worker.mjs",
    outputRoot: createDefaultCloudflareOutputRoot(rootDir),
    wranglerConfigKeys: ["workflows"],
    wranglerConfig,
  }
}

async function writeCloudflareWorkflowWrapper(rootDir: string, artifacts: GeneratedWorkflowArtifacts) {
  const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
  const workflowConfig = artifacts.cloudflareWorkflowConfig && artifacts.cloudflareWorkflowConfig.provider === "cloudflare"
    ? artifacts.cloudflareWorkflowConfig
    : false
  const workflowDefinitions = workflowConfig ? artifacts.providerDefinitions : []
  await writeFile(resolve(outputRoot, "index.js"), renderCloudflareWorkerWrapper(workflowDefinitions), "utf8")
}

function createVercelOutput(artifacts: GeneratedWorkflowArtifacts): VercelProviderDeploymentOutput {
  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      external: ["@cloudflare/sandbox", "cloudflare:workers", "workflow", "workflow/api", "workflow/runtime"],
      format: "esm",
      platform: "node",
    },
  }
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedWorkflowArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.workflow)
  const cloudflareWorkflowConfig = resolveWorkflowConfig(options.workflow, "cloudflare")
  const vercelWorkflowConfig = resolveWorkflowConfig(options.workflow, "vercel")
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    ...(cloudflareWorkflowConfig && cloudflareWorkflowConfig.provider === "cloudflare"
      ? { cloudflare: createCloudflareOutput(options.rootDir, artifacts) }
      : {}),
    cleanup: {
      cloudflare: {
        bundleOutfileName: "worker.mjs",
        outputRoot: createDefaultCloudflareOutputRoot(options.rootDir),
        wranglerConfigKeys: ["workflows"],
      },
    },
    rootDir: options.rootDir,
    ...(vercelWorkflowConfig && vercelWorkflowConfig.provider === "vercel"
      ? { vercel: createVercelOutput(artifacts) }
      : {}),
  })
  if (cloudflareWorkflowConfig && cloudflareWorkflowConfig.provider === "cloudflare") {
    await writeCloudflareWorkflowWrapper(options.rootDir, artifacts)
  }
  return artifacts
}
