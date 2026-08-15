import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { readColocatedAgentFiles } from "@vite-hub/internal/build/colocated-agent-files"
import { createDefaultCloudflareOutputRoot, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_MODES, getViteMode } from "@vite-hub/internal/build/mode"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import type { Plugin } from "esbuild"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../integrations/cloudflare.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions, WorkflowModuleOptions, WorkflowProvider } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as VitePlugin } from "vite"

export const workflowPackageName = "@vite-hub/workflow"
const productName = "workflow"

const generatedRegistryFileName = "registry.mjs"
const cloudflareWorkflowWranglerConfigKeys = ["compatibility_date", "compatibility_flags", "main", "observability", "workflows"]
const cloudflareWorkflowWrapperImport = `import worker, { runViteHubWorkflowDefinition } from "./worker.mjs"`
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)
const nodeBuiltinExternals = [...new Set(["node:*", ...builtinModules, ...builtinModules.map(module => `node:${module}`)])]
const optionalAgentRuntimeExternals = ["@vite-hub/workspace", "@vite-hub/workspace/*"]
const optionalViteDevtoolsPattern = /^@vitejs\/devtools-(?:oxc|rolldown|vite|vitest)(?:\/.*)?$/
const WORKFLOW_ENTRY_BASE_NAMES = ["server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"] as const
const WORKFLOW_PRIORITY_NAMES = ["server-workflow.ts", "server-workflow.mts", "server-workflow.js", "server-workflow.mjs"] as const
interface VercelWorkflowBuilders {
  VercelBuildOutputAPIBuilder: new (options: {
    buildTarget: "vercel-build-output-api"
    dirs: string[]
    projectRoot: string
    stepsBundlePath: string
    webhookBundlePath: string
    workflowsBundlePath: string
    workingDir: string
  }) => { build: () => Promise<void> }
  createSwcPlugin: (options: { mode: "workflow", projectRoot: string }) => Plugin
}

function createOptionalViteDevtoolsPlugin(rootDir: string): Plugin {
  const require = createRequire(join(rootDir, "package.json"))
  const namespace = "vitehub-optional-vite-devtools"
  return {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: optionalViteDevtoolsPattern }, (args) => {
        try {
          require.resolve(args.path)
          return
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error
          return { namespace, path: args.path }
        }
      })
      build.onLoad({ filter: /.*/, namespace }, () => ({ contents: "export {}", loader: "js" }))
    },
  }
}

async function loadVercelWorkflowBuilders(): Promise<VercelWorkflowBuilders | undefined> {
  try {
    const require = createRequire(import.meta.url)
    require.resolve("workflow")
    require.resolve("@workflow/builders")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined
    throw error
  }
  return await import("@workflow/builders") as VercelWorkflowBuilders
}

async function createVercelWorkflowTransformPlugin(rootDir: string): Promise<Plugin | undefined> {
  const builders = await loadVercelWorkflowBuilders()
  if (!builders) return undefined
  return builders.createSwcPlugin({ mode: "workflow", projectRoot: rootDir })
}

async function withVercelWorkflowPackageLink<T>(rootDir: string, run: () => Promise<T>): Promise<T> {
  const target = join(rootDir, "node_modules", "workflow")
  if (existsSync(target)) return await run()

  // Workflow DevKit resolves its builtins from the application root, even when a framework owns the dependency.
  const require = createRequire(import.meta.url)
  const source = dirname(dirname(dirname(require.resolve("workflow/internal/builtins"))))
  await mkdir(dirname(target), { recursive: true })
  let ownsLink = false
  try {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir")
    ownsLink = true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }

  try {
    return await run()
  }
  finally {
    if (ownsLink) await rm(target, { force: true })
  }
}

async function buildVercelNativeWorkflowOutput(rootDir: string, definitions: DiscoveredWorkflowDefinition[], aliases: Record<string, string> = {}): Promise<void> {
  const builders = await loadVercelWorkflowBuilders()
  if (!definitions.length) return
  const definitionDirs = [...new Set(definitions.map(definition => dirname(definition.handler)))]
  let hasNativeEntry = false
  const visited = new Set<string>()
  const visit = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    if (!existsSync(file)) return
    if (statSync(file).isDirectory()) {
      for (const entry of readdirSync(file, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        if (entry.isDirectory() || /\.(?:c|m)?[jt]sx?$/.test(entry.name)) visit(join(file, entry.name))
      }
      return
    }
    const source = readFileSync(file, "utf8")
    if (/^\s*["']use workflow["'];?/m.test(source)) {
      const colocated = definitionDirs.some((definitionDir) => {
        const path = relative(definitionDir, file)
        return !path.startsWith("..") && !isAbsolute(path)
      })
      if (!colocated) {
        throw new Error(`Native Vercel workflow entry ${JSON.stringify(relative(rootDir, file))} must be colocated with its discovered workflow definition.`)
      }
      hasNativeEntry = true
    }
    for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const specifier = match[1]
      const alias = Object.entries(aliases)
        .find(([find]) => specifier === find || specifier.startsWith(`${find}/`))
      const imported = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : alias
          ? resolve(rootDir, specifier.replace(alias[0], alias[1]))
          : undefined
      if (!imported) continue
      const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
      const sourceBase = imported.replace(/\.(?:m|c)?js$/, "")
      const candidate = [
        imported,
        ...extensions.map(extension => `${sourceBase}${extension}`),
        ...extensions.map(extension => join(imported, `index${extension}`)),
      ]
        .find(path => existsSync(path) && statSync(path).isFile())
      if (candidate) visit(candidate)
    }
  }
  for (const definition of definitions) visit(definition.handler)
  if (!hasNativeEntry) return
  if (!builders) {
    throw new Error("Native Vercel workflows require the optional workflow and @workflow/builders peer dependencies.")
  }

  const outputConfigFile = resolve(rootDir, ".vercel", "output", "config.json")
  const viteHubConfig = JSON.parse(await readFile(outputConfigFile, "utf8")) as { routes?: unknown[] }
  const builder = new builders.VercelBuildOutputAPIBuilder({
    buildTarget: "vercel-build-output-api",
    dirs: definitionDirs,
    projectRoot: rootDir,
    stepsBundlePath: "./.well-known/workflow/v1/step.js",
    webhookBundlePath: "./.well-known/workflow/v1/webhook.js",
    workflowsBundlePath: "./.well-known/workflow/v1/flow.js",
    workingDir: rootDir,
  })
  await withVercelWorkflowPackageLink(rootDir, async () => await builder.build())
  const workflowConfig = JSON.parse(await readFile(outputConfigFile, "utf8")) as { routes?: unknown[], [key: string]: unknown }
  await writeFile(outputConfigFile, `${JSON.stringify({
    ...workflowConfig,
    ...viteHubConfig,
    routes: [...(workflowConfig.routes ?? []), ...(viteHubConfig.routes ?? [])],
  }, null, 2)}\n`, "utf8")
}

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
  agentImportBase?: string
  clientOutDir: string
  importBase?: string
  providerImportAliases?: Record<string, string>
  providerRuntimeImportAliases?: Partial<Record<WorkflowProvider, Record<string, string>>>
  rootDir: string
  serverDirs?: string[]
  serverFunctionName?: string
  includeUserAppEntry?: boolean
  workflow: WorkflowModuleOptions | undefined
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
  workspaceImportBase?: string
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

interface WorkspaceDependencyRuntimeImports {
  sandbox?: string
  sandboxRuntimeState?: string
  shellWorkspace?: string
}

interface WorkflowImportBases {
  agent?: string
  workflow?: string
  workspace?: string
  workspaceDependencies?: WorkspaceDependencyRuntimeImports
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

interface CloudflareWorkflowNitroOptions {
  agentImportBase?: string
  nitro: Record<string, unknown>
  rootDir: string
  serverDirs?: string[]
  includeUserAppEntry?: boolean
  workflow: WorkflowModuleOptions | undefined
  workflowImportBase?: string
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
  workspaceImportBase?: string
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function mergeCloudflareWorkersExternal(external: unknown): unknown {
  const cloudflareRuntimeModules = ["cloudflare:workers", "cloudflare:workflows"]
  if (external === undefined) return cloudflareRuntimeModules
  if (typeof external === "string") return [...new Set([external, ...cloudflareRuntimeModules])]
  if (external instanceof RegExp) return [external, ...cloudflareRuntimeModules]
  if (Array.isArray(external)) return [...new Set([...external, ...cloudflareRuntimeModules])]
  if (typeof external === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => cloudflareRuntimeModules.includes(source) || external(source, importer, isResolved)
  }
  return external
}

function createCloudflareWorkflowNitroPlugin(entryFile: string, definitions: DiscoveredWorkflowDefinition[]): VitePlugin {
  const moduleId = "virtual:vitehub-workflow-cloudflare-exports"
  const resolvedModuleId = `\0${moduleId}`
  const fileName = "workflow-cloudflare-exports.mjs"
  return {
    name: "vitehub-workflow-cloudflare-exports",
    buildStart() {
      this.emitFile({ fileName, id: moduleId, type: "chunk" })
    },
    resolveId(id: string) {
      if (id === moduleId) return resolvedModuleId
    },
    load(id: string) {
      if (id !== resolvedModuleId) return
      return [
        `import { WorkflowEntrypoint } from "cloudflare:workers"`,
        `import { installViteHubWorkflowRuntime, runViteHubWorkflowDefinition } from ${JSON.stringify(entryFile)}`,
        "",
        "installViteHubWorkflowRuntime()",
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
      ].join("\n")
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry || (chunk.fileName !== "index.mjs" && chunk.fileName !== "index.js")) return null
      const classes = definitions.map(definition => getCloudflareWorkflowClassName(definition.name)).join(", ")
      return { code: `${code}\nexport { ${classes} } from './${fileName}'\n`, map: null }
    },
  }
}

export async function createCloudflareWorkflowNitroConfig(options: CloudflareWorkflowNitroOptions): Promise<Record<string, unknown>> {
  const preset = String(options.nitro.preset || "")
  if (options.workflow === undefined && !preset.includes("cloudflare")) return options.nitro
  const config = normalizeWorkflowOptions(options.workflow, { hosting: preset })
  if (!config || config.provider !== "cloudflare") return options.nitro

  const artifacts = await writeProviderEntries(options.rootDir, options.workflow, {
    agent: options.agentImportBase,
    workflow: options.workflowImportBase,
    workspace: options.workspaceImportBase,
    workspaceDependencies: options.workspaceDependencyRuntimeImports,
  }, options.serverDirs, options.includeUserAppEntry, options.transformRegistry)
  if (!artifacts.providerDefinitions.length) return options.nitro

  const nitro = { ...options.nitro }
  const cloudflare = { ...record(nitro.cloudflare) }
  const wrangler = { ...record(cloudflare.wrangler) }
  const workflows = createCloudflareWorkflowBindings(artifacts.providerDefinitions, config)
  const existingWorkflows = Array.isArray(wrangler.workflows) ? [...wrangler.workflows] : []
  for (const workflow of workflows || []) {
    if (!existingWorkflows.some(entry => record(entry).binding === workflow.binding && record(entry).class_name === workflow.class_name && record(entry).name === workflow.name)) {
      existingWorkflows.push(workflow)
    }
  }
  wrangler.workflows = existingWorkflows
  cloudflare.wrangler = wrangler
  nitro.cloudflare = cloudflare

  const rollupConfig = { ...record(nitro.rollupConfig) }
  const plugins = Array.isArray(rollupConfig.plugins) ? [...rollupConfig.plugins] : []
  if (!plugins.some(plugin => record(plugin).name === "vitehub-workflow-cloudflare-exports")) {
    plugins.push(createCloudflareWorkflowNitroPlugin(artifacts.cloudflareWorkerFile, artifacts.providerDefinitions))
  }
  rollupConfig.plugins = plugins
  rollupConfig.external = mergeCloudflareWorkersExternal(rollupConfig.external)
  nitro.rollupConfig = rollupConfig
  return nitro
}

function renderRegistryImport(registryFile: string, file: string): string {
  return `import(${JSON.stringify(createImportPath(registryFile, file))})`
}

function resolveAgentWorkspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
}

function resolveInstructionFile(file: string, seen: Set<string>): string {
  if (seen.has(file)) throw new Error(`[vitehub] Circular instruction import: ${file}.`)
  seen.add(file)
  try {
    const replaceImports = (content: string) => content.replace(/@(\.\.?\/\S+)/g, (_token, rawSpecifier: string) => {
      const trailing = rawSpecifier.match(/[.,;:!?)]*$/)?.[0] || ""
      const specifier = rawSpecifier.slice(0, rawSpecifier.length - trailing.length)
      return `${resolveInstructionFile(resolve(dirname(file), specifier), seen)}${trailing}`
    })
    let fence: string | undefined
    return readFileSync(file, "utf8").split(/(?<=\n)/).map((line) => {
      const marker = line.match(/^\s*(```|~~~)/)?.[1]
      if (marker) {
        fence = fence === marker ? undefined : fence || marker
        return line
      }
      if (fence) return line
      if (/^(?: {4}|\t)/.test(line)) return line
      return line.split(/(`+[^`]*`+)/g).map((segment, index) => index % 2 ? segment : replaceImports(segment)).join("")
    }).join("")
  }
  finally {
    seen.delete(file)
  }
}

function readAgentInstructions(file: string): string | undefined {
  const instructions = join(dirname(file), "instructions.md")
  return existsSync(instructions) && statSync(instructions).isFile()
    ? resolveInstructionFile(instructions, new Set())
    : undefined
}

function readAgentSkills(file: string): Record<string, { content: string, encoding: "base64", materialize: "build", mount: "", workspacePath: string }> | undefined {
  const files = readColocatedAgentFiles(file, "skills")
  if (!files) return
  return Object.fromEntries(Object.entries(files).map(([path, source]) => {
    const workspacePath = `skills/${path}`
    return [
      `__vitehubAgentSkill:${workspacePath}`,
      {
        ...source,
        materialize: "build",
        mount: "",
        workspacePath,
      },
    ]
  }))
}

function readAgentHome(file: string): Record<string, { contents: string, encoding: "base64" }> | undefined {
  const files = readColocatedAgentFiles(file, "home", {
    fileCountLimit: 1024,
    fileSizeLimit: 1024 * 1024,
    label: "Colocated Agent Home",
    rejectUnsupportedEntries: true,
    totalSizeLimit: 4 * 1024 * 1024,
  })
  if (!files) return
  return Object.fromEntries(Object.entries(files).map(([target, source]) => [
    target,
    { contents: source.content, encoding: source.encoding },
  ]))
}

function renderAgentWorkflowRegistryEntry(registryFile: string, definition: DiscoveredWorkflowDefinition) {
  return [
    `  ${JSON.stringify(definition.name)}: async () => {`,
    `    const cached = registryEntryCache.get(${JSON.stringify(definition.name)})`,
    "    if (cached) return cached",
    `    const loaded = await ${renderRegistryImport(registryFile, definition.handler)}`,
    `    const agent = agentWithColocatedHome(agentWithColocatedSkills(workspaceAgentWithSourceRoot(agentWithColocatedInstructions("default" in loaded ? loaded.default : loaded, ${JSON.stringify(readAgentInstructions(definition.handler))}), ${JSON.stringify(resolveAgentWorkspaceSourceRoot(definition.handler))}, ${JSON.stringify(readAgentInstructions(definition.handler))}), ${JSON.stringify(readAgentSkills(definition.handler))}), ${JSON.stringify(readAgentHome(definition.handler))})`,
    `    const entry = { handler: async (context) => await runAgentWorkflowDefinition(agent, { ...context, payload: { ...context.payload, agentIdentity: context.payload?.agentIdentity || { name: ${JSON.stringify(definition.agentIdentity || definition.name)} } } }, runAgentInline) }`,
    `    registryEntryCache.set(${JSON.stringify(definition.name)}, entry)`,
    "    return entry",
    "  },",
  ].join("\n")
}

function renderWorkflowRegistryEntry(registryFile: string, definition: DiscoveredWorkflowDefinition) {
  if (definition.source === "agent-workflow") {
    return renderAgentWorkflowRegistryEntry(registryFile, definition)
  }

  if (!definition.steps?.length) {
    return `  ${JSON.stringify(definition.name)}: async () => ${renderRegistryImport(registryFile, definition.handler)},`
  }

  const workflowDirectory = /\.(?:c|m)?[jt]s$/i.test(definition.handler) ? dirname(definition.handler) : definition.handler
  const stepImports = definition.steps.map((step) => {
    const stepName = relative(workflowDirectory, step)
    return `{ name: ${JSON.stringify(stepName)}, run: (await ${renderRegistryImport(registryFile, step)}).default }`
  })

  const hasIndex = /\.(?:c|m)?[jt]s$/i.test(definition.handler)
  const indexImport = hasIndex ? `const index = await ${renderRegistryImport(registryFile, definition.handler)}` : ""
  const handler = hasIndex
    ? `index.default?.handler ? index.default : takeInlineWorkflowDefinitionForModule(${JSON.stringify(definition.name)}, index) || { handler: index.default }`
    : "{ handler: async (context) => { let value = context.payload; for (const step of Object.values(context.steps || {})) value = await step(value); return value } }"

  return [
    `  ${JSON.stringify(definition.name)}: async () => {`,
    `    const cached = registryEntryCache.get(${JSON.stringify(definition.name)})`,
    "    if (cached) return cached",
    indexImport ? `    ${indexImport}` : "",
    `    const steps = [${stepImports.join(", ")}]`,
    `    const definition = ${handler}`,
    "    const entry = {",
    "      ...definition,",
    "      options: { ...definition.options, rootStep: false },",
    "      handler: async (context) => {",
    "        const workflowSteps = createWorkflowSteps(context, steps)",
    "        return await definition.handler({ ...context, steps: workflowSteps })",
    "      },",
    "    }",
    `    registryEntryCache.set(${JSON.stringify(definition.name)}, entry)`,
    "    return entry",
    "  },",
  ].filter(Boolean).join("\n")
}

function createWorkflowRegistryContents(
  registryFile: string,
  definitions: DiscoveredWorkflowDefinition[],
  importBases: WorkflowImportBases = {},
): string {
  const agentImportBase = importBases.agent ?? "@vite-hub/agent"
  const workflowImportBase = importBases.workflow ?? workflowPackageName
  const needsWorkflowRuntime = definitions.some(definition => definition.steps?.length)
  const needsAgentRuntime = definitions.some(definition => definition.source === "agent-workflow")
  const needsRegistryEntryCache = needsWorkflowRuntime || needsAgentRuntime
  const installAgentWorkflowRuntime = needsAgentRuntime && importBases.workflow
  const workspaceDependencyRuntimeImports = importBases.workspace ? importBases.workspaceDependencies : undefined
  const imports = [
    ...(needsAgentRuntime
      ? [
          `import { agentWithColocatedInstructions, runAgentInline } from ${JSON.stringify(agentImportBase)}`,
          `import { agentWithColocatedHome, agentWithColocatedSkills, runAgentWorkflowDefinition, workspaceAgentWithSourceRoot } from ${JSON.stringify(`${agentImportBase}/runtime/workflow`)}`,
          `import { installAgentChannelDeliveryWorkflowResolver } from ${JSON.stringify(`${agentImportBase}/server/internal`)}`,
          ...(installAgentWorkflowRuntime
            ? [`import { setAgentWorkflowRuntimeLoaders } from ${JSON.stringify(`${agentImportBase}/server/internal`)}`]
            : []),
        ]
      : []),
    ...(needsWorkflowRuntime
      ? [
          `import { createWorkflowSteps } from ${JSON.stringify(`${workflowImportBase}/runtime/execute`)}`,
          `import { takeInlineWorkflowDefinitionForModule } from ${JSON.stringify(`${workflowImportBase}/runtime/state`)}`,
        ]
      : []),
    ...(workspaceDependencyRuntimeImports
      ? [`import { setWorkspaceDependencyRuntimeLoaders } from ${JSON.stringify(`${importBases.workspace}/runtime`)}`]
      : []),
  ]

  return [
    ...imports,
    imports.length ? "" : "",
    ...(needsAgentRuntime ? ["installAgentChannelDeliveryWorkflowResolver()", ""] : []),
    ...(installAgentWorkflowRuntime
      ? [
          "setAgentWorkflowRuntimeLoaders({",
          `  state: () => import(${JSON.stringify(`${importBases.workflow}/runtime/state`)}),`,
          `  workflow: () => import(${JSON.stringify(importBases.workflow)}),`,
          "})",
          "",
        ]
      : []),
    ...(workspaceDependencyRuntimeImports
      ? [
          "setWorkspaceDependencyRuntimeLoaders({",
          ...(workspaceDependencyRuntimeImports.sandbox
            ? [`  sandbox: () => import(${JSON.stringify(workspaceDependencyRuntimeImports.sandbox)}),`]
            : []),
          ...(workspaceDependencyRuntimeImports.sandboxRuntimeState
            ? [`  sandboxRuntimeState: () => import(${JSON.stringify(workspaceDependencyRuntimeImports.sandboxRuntimeState)}),`]
            : []),
          ...(workspaceDependencyRuntimeImports.shellWorkspace
            ? [`  shellWorkspace: () => import(${JSON.stringify(workspaceDependencyRuntimeImports.shellWorkspace)}),`]
            : []),
          "})",
          "",
        ]
      : []),
    ...(needsRegistryEntryCache ? ["const registryEntryCache = new Map()", ""] : []),
    "const registry = {",
    ...definitions.map(definition => renderWorkflowRegistryEntry(registryFile, definition)),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}

function renderCloudflareWorkerWrapper(definitions: DiscoveredWorkflowDefinition[]) {
  return [
    definitions.length ? `import { WorkflowEntrypoint, waitUntil as viteHubWaitUntil } from "cloudflare:workers"` : `import { waitUntil as viteHubWaitUntil } from "cloudflare:workers"`,
    cloudflareWorkflowWrapperImport,
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
  framework: boolean,
) {
  const installVercelWorkflowRuntime = spec.name === "vercel" && framework
  const imports = [
    `import { ${spec.factory}${spec.name === "cloudflare" ? ", installWorkflowCloudflareRuntime" : ""}${installVercelWorkflowRuntime ? ", setVercelWorkflowRuntimeModules" : ""} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
    `import workflowRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
    ...(installVercelWorkflowRuntime ? [`import * as workflowApi from "workflow/api"`, `import * as workflowRuntime from "workflow/runtime"`] : []),
  ]
  if (spec.name === "cloudflare") {
    imports.push(`import { runCloudflareWorkflow } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("runtime/cloudflare-runner")))}`)
    imports.push(`import { NonRetryableError } from "cloudflare:workflows"`)
  }
  if (userAppEntry) {
    imports.push(`import workflowApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  const cloudflareDispatcher = spec.name === "cloudflare"
    ? [
        "",
        "export function installViteHubWorkflowRuntime() {",
        "  installWorkflowCloudflareRuntime({ registry: workflowRegistry, workflow: workflowConfig })",
        "}",
        "",
        "export async function runViteHubWorkflowDefinition(name, env, event, step) {",
        "  return await runCloudflareWorkflow({ config: workflowConfig, createNonRetryableError: error => new NonRetryableError(error.message, error.name), env: env || {}, event, name, registry: workflowRegistry, step })",
        "}",
      ]
    : []

  return [
    ...imports,
    "",
    installVercelWorkflowRuntime ? "setVercelWorkflowRuntimeModules(workflowApi, workflowRuntime)" : "",
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

async function writeProviderEntries(
  rootDir: string,
  workflow: WorkflowModuleOptions | undefined,
  importBases: WorkflowImportBases = {},
  serverDirs?: string[],
  includeUserAppEntry = true,
  transformRegistry?: (code: string, id: string) => string | Promise<string>,
) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverWorkflowDefinitions({ rootDir, serverDirs })
  const providerDefinitions = definitions
  const userAppEntry = includeUserAppEntry ? resolveWorkflowUserAppEntry(rootDir) : undefined
  const cloudflareWorkflowConfig = resolveWorkflowConfig(workflow, "cloudflare")

  const registryContents = createWorkflowRegistryContents(registryFile, definitions, importBases)
  await writeFile(registryFile, transformRegistry ? await transformRegistry(registryContents, registryFile) : registryContents, "utf8")

  const entryFiles: Record<WorkflowProvider, string> = { cloudflare: "", openworkflow: "", vercel: "" }
  await Promise.all(providerEntrySpecs.map(async (spec) => {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const workflowConfig = spec.name === "cloudflare"
      ? cloudflareWorkflowConfig
      : resolveWorkflowConfig(workflow, spec.hosting)
    const serialized = JSON.stringify(workflowConfig, null, 2)
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, userAppEntry, serialized, Boolean(importBases.workflow)), "utf8")
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

function createCloudflareOutput(
  rootDir: string,
  artifacts: GeneratedWorkflowArtifacts,
  providerImportAliases?: Record<string, string>,
): CloudflareProviderDeploymentOutput {
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
      alias: providerImportAliases,
      conditions: ["workerd", "worker", "browser", "default"],
      external: [
        "@cloudflare/sandbox",
        "@vercel/blob",
        "@vercel/functions",
        "@vercel/queue",
        "@vercel/sandbox",
        "cloudflare:workers",
        "cloudflare:workflows",
        ...nodeBuiltinExternals,
        "workflow",
        "workflow/api",
        "workflow/runtime",
      ],
      format: "esm",
      platform: "neutral",
      plugins: [createOptionalViteDevtoolsPlugin(rootDir)],
    },
    bundleOutfileName: "worker.mjs",
    files: { "index.js": createCloudflareWorkflowWrapper(artifacts) },
    outputRoot: createDefaultCloudflareOutputRoot(rootDir),
    wranglerConfigKeys: cloudflareWorkflowWranglerConfigKeys,
    wranglerConfig,
  }
}

function createCloudflareWorkflowWrapper(artifacts: GeneratedWorkflowArtifacts): string {
  const workflowConfig = artifacts.cloudflareWorkflowConfig && artifacts.cloudflareWorkflowConfig.provider === "cloudflare"
    ? artifacts.cloudflareWorkflowConfig
    : false
  const workflowDefinitions = workflowConfig ? artifacts.providerDefinitions : []
  return renderCloudflareWorkerWrapper(workflowDefinitions)
}

async function createCloudflareWorkflowCleanup(rootDir: string) {
  const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
  let ownsWrapper = false
  try {
    ownsWrapper = (await readFile(resolve(outputRoot, "index.js"), "utf8")).includes(cloudflareWorkflowWrapperImport)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return {
    fileNames: ownsWrapper ? ["index.js", "worker.mjs"] : ["worker.mjs"],
    outputRoot,
    wranglerConfigOwnership: {
      keys: ownsWrapper ? cloudflareWorkflowWranglerConfigKeys : ["workflows"],
    },
  }
}

function createVercelOutput(
  rootDir: string,
  artifacts: GeneratedWorkflowArtifacts,
  workflowTransformPlugin: Plugin | undefined,
  frameworkImportBase?: string,
  providerImportAliases?: Record<string, string>,
  serverFunctionName?: string,
): VercelProviderDeploymentOutput {
  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      alias: providerImportAliases,
      external: [
        "@cloudflare/sandbox",
        ...(frameworkImportBase ? [] : optionalAgentRuntimeExternals),
        "cloudflare:workers",
        ...nodeBuiltinExternals,
        ...(!frameworkImportBase ? ["workflow", "workflow/api", "workflow/runtime"] : []),
      ],
      format: "esm",
      platform: "node",
      plugins: [
        createOptionalViteDevtoolsPlugin(rootDir),
        ...(workflowTransformPlugin ? [workflowTransformPlugin] : []),
      ],
    },
    ...(serverFunctionName ? { function: { kind: "isolated" as const, name: serverFunctionName } } : {}),
  }
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedWorkflowArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.workflow, {
    agent: options.agentImportBase,
    workflow: options.importBase,
    workspace: options.workspaceImportBase,
    workspaceDependencies: options.workspaceDependencyRuntimeImports,
  }, options.serverDirs, options.includeUserAppEntry, options.transformRegistry)
  const cloudflareWorkflowConfig = resolveWorkflowConfig(options.workflow, "cloudflare")
  const vercelWorkflowConfig = resolveWorkflowConfig(options.workflow, "vercel")
  const cloudflareOutput = cloudflareWorkflowConfig && cloudflareWorkflowConfig.provider === "cloudflare"
    ? createCloudflareOutput(options.rootDir, artifacts, {
        ...options.providerImportAliases,
        ...options.providerRuntimeImportAliases?.cloudflare,
      })
    : undefined
  const workflowTransformPlugin = vercelWorkflowConfig && vercelWorkflowConfig.provider === "vercel"
    ? await createVercelWorkflowTransformPlugin(options.rootDir)
    : undefined
  const vercelOutput = vercelWorkflowConfig && vercelWorkflowConfig.provider === "vercel"
    ? createVercelOutput(options.rootDir, artifacts, workflowTransformPlugin, options.importBase, {
        ...options.providerImportAliases,
        ...options.providerRuntimeImportAliases?.vercel,
      }, options.serverFunctionName)
    : undefined
  const writeOutputs = async () => {
    await writeProviderDeploymentOutputs({
      clientOutDir: options.clientOutDir,
      cloudflare: cloudflareOutput,
      cleanup: {
        cloudflare: cloudflareOutput ? undefined : () => createCloudflareWorkflowCleanup(options.rootDir),
      },
      rootDir: options.rootDir,
      ...(vercelOutput ? { vercel: vercelOutput } : {}),
    })
    if (vercelOutput) await buildVercelNativeWorkflowOutput(options.rootDir, artifacts.providerDefinitions, {
      ...options.providerImportAliases,
      ...options.providerRuntimeImportAliases?.vercel,
    })
  }
  if (workflowTransformPlugin && options.importBase) await withVercelWorkflowPackageLink(options.rootDir, writeOutputs)
  else await writeOutputs()
  return artifacts
}
