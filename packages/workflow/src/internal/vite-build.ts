import { hasRuntimeType } from "./runtime-type.ts"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { getAgentInvocationRecoveryWorkflowName } from "@vite-hub/internal/agent-workflow"
import { readColocatedAgentFiles } from "@vite-hub/internal/build/colocated-agent-files"
import { createImportPath } from "@vite-hub/internal/build/paths"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { buildSync } from "esbuild"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../integrations/cloudflare.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions, WorkflowModuleOptions } from "../types.ts"
import type { Plugin as VitePlugin } from "vite"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

export const workflowPackageName = "@vite-hub/workflow"
/** Build output that Nitro bundles. `vite dev` uses `.vitehub/nitro/workflow` instead. */
export const workflowGeneratedDir = ".vitehub/workflow"
const registryFileName = "registry.mjs"
const cloudflareEntryFileName = "cloudflare-workflows.mjs"
const nitroPluginFileName = "nitro-plugin.mjs"
const nitroMiddlewareFileName = "nitro-middleware.mjs"
const cloudflareExportsPluginName = "vitehub-workflow-cloudflare-exports"

export function hasVercelNativeWorkflowEntry(rootDir: string, definitions: DiscoveredWorkflowDefinition[], aliases: Record<string, string> = {}, nativeFiles: string[] = []): boolean {
  if (!definitions.length) return false
  const definitionDirs = [...new Set([
    ...definitions.map(definition => dirname(definition.handler)),
    ...nativeFiles.map(file => dirname(file)),
  ])]
  let hasNativeEntry = false
  const visited = new Set<string>()
  const definitionHandlers = new Set(definitions.map(definition => definition.handler))
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
    const parsed = buildSync({
      bundle: false,
      format: "esm",
      legalComments: "none",
      metafile: true,
      minifySyntax: true,
      stdin: {
        contents: source,
        loader: /\.[cm]?[jt]sx$/.test(file) ? "tsx" : "ts",
        sourcefile: file,
      },
      write: false,
    })
    const parsedSource = parsed.outputFiles[0].text
    if (/^\s*["']use workflow["'];?/m.test(parsedSource)) {
      const colocated = definitionDirs.some((definitionDir) => {
        const path = relative(definitionDir, file)
        return !path.startsWith("..") && !isAbsolute(path)
      })
      if (!colocated) {
        throw workflowErrorDiagnostics.WORKFLOW_R0004({ message: `Native Vercel workflow entry ${JSON.stringify(relative(rootDir, file))} must be colocated with its discovered workflow definition.` })
      }
      hasNativeEntry = true
    }
    if (definitionHandlers.has(file) && !/\bnative\s*(?::|(?=[,}]))/.test(parsedSource)) return
    const imports = Object.values(parsed.metafile.outputs).flatMap(output => output.imports)
    for (const { path: specifier } of imports) {
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
  for (const file of nativeFiles) visit(file)
  return hasNativeEntry
}

function record(value: unknown): Record<string, unknown> {
  // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
  return value && hasRuntimeType(value, "object") ? value as Record<string, unknown> : {}
}

function mergeCloudflareWorkersExternal(external: unknown): unknown {
  const cloudflareRuntimeModules = ["cloudflare:workers", "cloudflare:workflows"]
  if (external === undefined) return cloudflareRuntimeModules
  if (hasRuntimeType(external, "string")) return [...new Set([external, ...cloudflareRuntimeModules])]
  if (external instanceof RegExp) return [external, ...cloudflareRuntimeModules]
  if (Array.isArray(external)) return [...new Set([...external, ...cloudflareRuntimeModules])]
  if (hasRuntimeType(external, "function")) {
    return (source: string, importer?: string, isResolved?: boolean) => cloudflareRuntimeModules.includes(source) || external(source, importer, isResolved)
  }
  return external
}

function createCloudflareWorkflowNitroPlugin(entryFile: string, definitions: DiscoveredWorkflowDefinition[]): VitePlugin {
  const moduleId = "virtual:vitehub-workflow-cloudflare-exports"
  const resolvedModuleId = `\0${moduleId}`
  const fileName = "workflow-cloudflare-exports.mjs"
  return {
    name: cloudflareExportsPluginName,
    buildStart() {
      this.emitFile({ fileName, id: moduleId, type: "chunk" })
    },
    resolveId(id: string) {
      if (id === moduleId) return resolvedModuleId
      if (id.startsWith("file:")) return fileURLToPath(id)
    },
    load(id: string) {
      if (id !== resolvedModuleId) return
      return [
        `import { WorkflowEntrypoint } from "cloudflare:workers"`,
        `import { runViteHubWorkflowDefinition } from ${JSON.stringify(entryFile)}`,
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

function renderRegistryImport(registryFile: string, file: string): string {
  return `import(${JSON.stringify(pathToFileURL(file).href)})`
}

function resolveAgentWorkspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
}

function readAgentInstructions(file: string): string | undefined {
  const instructions = join(dirname(file), "instructions.md")
  if (!existsSync(instructions) || !statSync(instructions).isFile()) return
  return readFileSync(instructions, "utf8")
}

function readAgentSkills(file: string): Record<string, { content: string, encoding: "base64", materialize: "startup", mount: "", workspacePath: string }> | undefined {
  const files = readColocatedAgentFiles(file, "skills")
  if (!files) return
  return Object.fromEntries(Object.entries(files).map(([path, source]) => {
    const workspacePath = `.agents/skills/${path}`
    return [
      `__vitehubAgentSkill:${workspacePath}`,
      {
        ...source,
        materialize: "startup",
        mount: "",
        workspacePath,
      },
    ]
  }))
}

function renderAgentWorkflowRegistryEntry(
  registryFile: string,
  definition: DiscoveredWorkflowDefinition,
) {
  const instructions = readAgentInstructions(definition.handler)
  return [
    `  [${JSON.stringify(definition.name)}]: Object.assign(async () => {`,
    `    const cached = registryEntryCache.get(${JSON.stringify(definition.name)})`,
    "    if (cached) return cached",
    `    const loaded = await ${renderRegistryImport(registryFile, definition.handler)}`,
    `    const agent = workspaceAgentWithSourceRoot(agentWithColocatedSkills(agentWithColocatedInstructions("default" in loaded ? loaded.default : loaded, ${JSON.stringify(instructions)}), ${JSON.stringify(readAgentSkills(definition.handler))}), ${JSON.stringify(resolveAgentWorkspaceSourceRoot(definition.handler))}, ${JSON.stringify(instructions)})`,
    `    const entry = { options: { rootStep: false }, handler: async (context) => await runAgentWorkflowDefinition(agent, { ...context, payload: { ...context.payload, agentIdentity: context.payload?.agentIdentity || { name: ${JSON.stringify(definition.agentIdentity || definition.name)} } } }, runAgentInline)${definition.source === "agent-workflow-recovery" ? ", internalAgentInvocationRecovery: true" : ""} }`,
    `    registryEntryCache.set(${JSON.stringify(definition.name)}, entry)`,
    "    return entry",
    `  }, ${definition.source === "agent-workflow-recovery" ? "{ internalAgentInvocationRecovery: true }" : "{}"}),`,
  ].join("\n")
}

function getGeneratedVercelWorkflowExport(definition: DiscoveredWorkflowDefinition): string | undefined {
  if (!definition.steps?.length || /\.(?:c|m)?[jt]s$/i.test(definition.handler)) return
  return `${getCloudflareWorkflowClassName(definition.name)}Native`
}

function createVercelNativeWorkflowContents(
  definition: DiscoveredWorkflowDefinition,
): string {
  const imports: string[] = []
  const workflows: string[] = []
  const workflowExport = getGeneratedVercelWorkflowExport(definition)
  const steps = definition.steps
  if (!workflowExport || !steps) return ""
  const stepNames = steps.map((step, index) => {
    const implementation = `${workflowExport}Step${index}Implementation`
    const name = `${workflowExport}Step${index}`
    imports.push(`import ${implementation} from ${JSON.stringify(step)}`)
    workflows.push(`async function ${name}(input) {\n  "use step"\n  return await ${implementation}(input)\n}`)
    return name
  })
  workflows.push(`export async function ${workflowExport}(context) {\n  "use workflow"\n  let value = context.payload\n${stepNames.map(name => `  value = await ${name}(value)`).join("\n")}\n  return value\n}`)
  return [...imports, "", ...workflows, ""].join("\n")
}

function renderWorkflowRegistryEntry(
  registryFile: string,
  definition: DiscoveredWorkflowDefinition,
  vercelNativeFiles: Record<string, string> = {},
) {
  if (definition.source === "agent-workflow" || definition.source === "agent-workflow-recovery") {
    return renderAgentWorkflowRegistryEntry(registryFile, definition)
  }

  if (!definition.steps?.length) {
    return `  [${JSON.stringify(definition.name)}]: async () => ${renderRegistryImport(registryFile, definition.handler)},`
  }

  const workflowDirectory = /\.(?:c|m)?[jt]s$/i.test(definition.handler) ? dirname(definition.handler) : definition.handler
  const stepImports = definition.steps.map((step) => {
    const stepName = relative(workflowDirectory, step)
    return `{ name: ${JSON.stringify(stepName)}, run: (await ${renderRegistryImport(registryFile, step)}).default }`
  })

  const hasIndex = /\.(?:c|m)?[jt]s$/i.test(definition.handler)
  const indexImport = hasIndex ? `const index = await ${renderRegistryImport(registryFile, definition.handler)}` : ""
  const nativeExport = getGeneratedVercelWorkflowExport(definition)
  const vercelNativeFile = vercelNativeFiles[definition.name]
  const nativeImport = nativeExport && vercelNativeFile
    ? `const native = (await import(${JSON.stringify(createImportPath(registryFile, vercelNativeFile))})).${nativeExport}\n    native.workflowId ||= ${JSON.stringify(`workflow//./.vitehub/workflow/vercel-native//${nativeExport}`)}`
    : ""
  const handler = hasIndex
    ? `index.default?.handler ? index.default : takeInlineWorkflowDefinitionForModule(${JSON.stringify(definition.name)}, index) || { handler: index.default }`
    : "{ handler: async (context) => { let value = context.payload; for (const step of Object.values(context.steps || {})) value = await step(value); return value } }"

  return [
    `  [${JSON.stringify(definition.name)}]: async () => {`,
    `    const cached = registryEntryCache.get(${JSON.stringify(definition.name)})`,
    "    if (cached) return cached",
    indexImport ? `    ${indexImport}` : "",
    nativeImport ? `    ${nativeImport}` : "",
    `    const steps = [${stepImports.join(", ")}]`,
    `    const definition = ${handler}`,
    "    const entry = {",
    "      ...definition,",
    `      options: { ...definition.options, rootStep: false${nativeImport ? ", native" : ""} },`,
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

export function createWorkflowRegistryContents(
  registryFile: string,
  definitions: DiscoveredWorkflowDefinition[],
  importBases: WorkflowImportBases = {},
  vercelNativeFiles: Record<string, string> = {},
): string {
  const agentImportBase = importBases.agent ?? "@vite-hub/agent"
  const workflowImportBase = importBases.workflow ?? workflowPackageName
  const needsWorkflowRuntime = definitions.some(definition => definition.steps?.length)
  const needsAgentRuntime = definitions.some(definition => definition.source === "agent-workflow" || definition.source === "agent-workflow-recovery")
  const needsRegistryEntryCache = needsWorkflowRuntime || needsAgentRuntime
  const installAgentWorkflowRuntime = needsAgentRuntime && importBases.workflow
  const workspaceDependencyRuntimeImports = importBases.workspace ? importBases.workspaceDependencies : undefined
  const imports = [
    ...(needsAgentRuntime
      ? [
          `import { agentWithColocatedInstructions, runAgentInline } from ${JSON.stringify(agentImportBase)}`,
          `import { agentWithColocatedSkills, runAgentWorkflowDefinition, workspaceAgentWithSourceRoot } from ${JSON.stringify(`${agentImportBase}/runtime/workflow`)}`,
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
          ...(workspaceDependencyRuntimeImports.sandboxTask
            ? [`  sandboxTask: () => import(${JSON.stringify(workspaceDependencyRuntimeImports.sandboxTask)}),`]
            : []),
          ...(workspaceDependencyRuntimeImports.sandboxTaskRuntimeState
            ? [`  sandboxTaskRuntimeState: () => import(${JSON.stringify(workspaceDependencyRuntimeImports.sandboxTaskRuntimeState)}),`]
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
    ...definitions.map(definition => renderWorkflowRegistryEntry(registryFile, definition, vercelNativeFiles)),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}

interface WorkspaceDependencyRuntimeImports {
  sandboxTask?: string
  sandboxTaskRuntimeState?: string
  shellWorkspace?: string
}

export interface WorkflowImportBases {
  agent?: string
  workflow?: string
  workspace?: string
  workspaceDependencies?: WorkspaceDependencyRuntimeImports
}

export interface WorkflowNitroEntries {
  /** Module that runs Cloudflare Workflow classes. Only for the Cloudflare provider. */
  cloudflareEntryFile?: string
  definitions: DiscoveredWorkflowDefinition[]
  middlewareFile: string
  pluginFile: string
  /** Definitions plus the generated Agent invocation recovery Workflows. */
  providerDefinitions: DiscoveredWorkflowDefinition[]
  registryFile: string
  /** True when Vercel Workflow must build `"use workflow"` functions. */
  vercelNative: boolean
  vercelNativeFiles: string[]
}

export interface WorkflowNitroEntriesOptions {
  /** Aliases that native Vercel entry detection follows. */
  aliases?: Record<string, string>
  /** Directory that Workflow discovery reads. Defaults to the project root. */
  definitionRootDir?: string
  importBases?: WorkflowImportBases
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

function renderCloudflareEntry(config: ResolvedWorkflowOptions, workflowImportBase: string): string {
  return [
    `import { runCloudflareWorkflow } from ${JSON.stringify(`${workflowImportBase}/runtime/cloudflare-runner`)}`,
    `import { NonRetryableError } from "cloudflare:workflows"`,
    `import workflowRegistry from ${JSON.stringify(`./${registryFileName}`)}`,
    "",
    `const workflowConfig = ${JSON.stringify(config, null, 2)}`,
    "",
    "export async function runViteHubWorkflowDefinition(name, env, event, step) {",
    "  return await runCloudflareWorkflow({ config: workflowConfig, createNonRetryableError: error => new NonRetryableError(error.message, error.name), env: env || {}, event, name, registry: workflowRegistry, step })",
    "}",
    "",
  ].join("\n")
}

function renderNitroPlugin(config: ResolvedWorkflowOptions, workflowImportBase: string, vercelNative: boolean): string {
  return [
    `import { definePlugin } from "nitro"`,
    `import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from ${JSON.stringify(`${workflowImportBase}/runtime/state`)}`,
    ...(vercelNative
      ? [
          `import { setVercelWorkflowRuntimeModules } from ${JSON.stringify(`${workflowImportBase}/runtime/vercel`)}`,
          `import * as workflowApi from "workflow/api"`,
          `import * as workflowRuntime from "workflow/runtime"`,
        ]
      : []),
    `import workflowRegistry from ${JSON.stringify(`./${registryFileName}`)}`,
    "",
    "export default definePlugin(() => {",
    `  setWorkflowRuntimeConfig(${JSON.stringify(config)})`,
    "  setWorkflowRuntimeRegistry(workflowRegistry)",
    ...(vercelNative ? ["  setVercelWorkflowRuntimeModules(workflowApi, workflowRuntime)"] : []),
    "})",
    "",
  ].join("\n")
}

function renderNitroMiddleware(workflowImportBase: string): string {
  return [
    `import { defineMiddleware } from "nitro"`,
    `import { enterWorkflowRuntimeEvent } from ${JSON.stringify(`${workflowImportBase}/runtime/state`)}`,
    "",
    "// Workflow reads the host env and waitUntil from the request event.",
    "export default defineMiddleware((event) => {",
    "  enterWorkflowRuntimeEvent(event)",
    "})",
    "",
  ].join("\n")
}

/**
 * Writes the Workflow registry and the Nitro plugin and middleware that install it.
 * Nitro bundles these files into the host output.
 */
export async function writeWorkflowNitroEntries(
  rootDir: string,
  config: ResolvedWorkflowOptions,
  options: WorkflowNitroEntriesOptions = {},
): Promise<WorkflowNitroEntries> {
  const generatedDir = resolve(rootDir, workflowGeneratedDir)
  await mkdir(generatedDir, { recursive: true })
  const importBases = options.importBases ?? {}
  const workflowImportBase = importBases.workflow ?? workflowPackageName

  const definitions = discoverWorkflowDefinitions({ rootDir: options.definitionRootDir ?? rootDir, serverDirs: options.serverDirs })
  const definitionNames = new Set(definitions.map(definition => definition.name))
  for (const definition of definitions) {
    if (definition.source !== "agent-workflow") continue
    const recoveryName = getAgentInvocationRecoveryWorkflowName(definition.name)
    if (definitionNames.has(recoveryName)) {
      throw workflowErrorDiagnostics.WORKFLOW_R0008({ message: `Workflow name ${JSON.stringify(recoveryName)} conflicts with the generated Agent invocation recovery Workflow for ${JSON.stringify(definition.name)}.` })
    }
  }
  const providerDefinitions = definitions.flatMap(definition => definition.source === "agent-workflow"
    ? [definition, {
        ...definition,
        agentIdentity: definition.agentIdentity || definition.name,
        name: getAgentInvocationRecoveryWorkflowName(definition.name),
        source: "agent-workflow-recovery" as const,
      }]
    : [definition])

  const vercelNativeDir = resolve(generatedDir, "vercel-native")
  const nativeDefinitions = config.provider === "vercel"
    ? definitions.filter(definition => getGeneratedVercelWorkflowExport(definition))
    : []
  await rm(vercelNativeDir, { force: true, recursive: true })
  const vercelNativeFiles = Object.fromEntries(nativeDefinitions.map(definition => [
    definition.name,
    resolve(vercelNativeDir, `${createHash("sha256").update(definition.name).digest("hex")}.mjs`),
  ]))
  if (nativeDefinitions.length) await mkdir(vercelNativeDir, { recursive: true })
  await Promise.all(nativeDefinitions.map(async definition => {
    await writeFile(vercelNativeFiles[definition.name]!, createVercelNativeWorkflowContents(definition), "utf8")
  }))

  const registryFile = resolve(generatedDir, registryFileName)
  const registryContents = createWorkflowRegistryContents(registryFile, providerDefinitions, importBases, vercelNativeFiles)
  await writeFile(registryFile, options.transformRegistry ? await options.transformRegistry(registryContents, registryFile) : registryContents, "utf8")

  const vercelNative = config.provider === "vercel"
    && hasVercelNativeWorkflowEntry(rootDir, definitions, options.aliases, Object.values(vercelNativeFiles))
  const cloudflareEntryFile = resolve(generatedDir, cloudflareEntryFileName)
  const pluginFile = resolve(generatedDir, nitroPluginFileName)
  const middlewareFile = resolve(generatedDir, nitroMiddlewareFileName)
  await Promise.all([
    config.provider === "cloudflare"
      ? writeFile(cloudflareEntryFile, renderCloudflareEntry(config, workflowImportBase), "utf8")
      : rm(cloudflareEntryFile, { force: true }),
    writeFile(pluginFile, renderNitroPlugin(config, workflowImportBase, vercelNative), "utf8"),
    writeFile(middlewareFile, renderNitroMiddleware(workflowImportBase), "utf8"),
  ])

  return {
    ...(config.provider === "cloudflare" ? { cloudflareEntryFile } : {}),
    definitions,
    middlewareFile,
    pluginFile,
    providerDefinitions,
    registryFile,
    vercelNative,
    vercelNativeFiles: Object.values(vercelNativeFiles),
  }
}

export interface WorkflowNitroConfigOptions extends WorkflowNitroEntriesOptions {
  /** Host preset to use when the Nitro config has no preset. */
  hosting?: string
  nitro: Record<string, unknown>
  rootDir: string
  /** Nitro runs inside Vite, so Vite plugins transform the server bundle. */
  vite?: boolean
  workflow: WorkflowModuleOptions | undefined
}

function addCloudflareWorkflows(nitro: Record<string, unknown>, entries: WorkflowNitroEntries, config: ResolvedWorkflowOptions): Record<string, unknown> {
  const cloudflare = { ...record(nitro.cloudflare) }
  const wrangler = { ...record(cloudflare.wrangler) }
  const workflows = Array.isArray(wrangler.workflows) ? [...wrangler.workflows] : []
  for (const workflow of createCloudflareWorkflowBindings(entries.providerDefinitions, config) ?? []) {
    if (!workflows.some(entry => record(entry).binding === workflow.binding && record(entry).class_name === workflow.class_name && record(entry).name === workflow.name)) {
      workflows.push(workflow)
    }
  }
  const rollupConfig = { ...record(nitro.rollupConfig) }
  const plugins = Array.isArray(rollupConfig.plugins)
    ? rollupConfig.plugins.filter(plugin => record(plugin).name !== cloudflareExportsPluginName)
    : []
  plugins.push(createCloudflareWorkflowNitroPlugin(entries.cloudflareEntryFile!, entries.providerDefinitions))
  return {
    ...nitro,
    cloudflare: { ...cloudflare, wrangler: { ...wrangler, workflows } },
    rollupConfig: { ...rollupConfig, external: mergeCloudflareWorkersExternal(rollupConfig.external), plugins },
  }
}

interface NitroModuleTarget {
  hooks: { hook: (name: "build:before" | "close", handler: () => void | Promise<void>) => unknown }
  options: { rootDir: string }
}

interface WorkflowNitroModule {
  name?: string
  setup: (nitro: NitroModuleTarget) => unknown
}

/**
 * Vercel Workflow resolves `workflow` from the application root, but the
 * application can get the package through `vite-hub`. Link it for the build and
 * remove the link when Nitro closes.
 */
function createWorkflowPackageLinkModule(): WorkflowNitroModule {
  return {
    name: "vitehub:workflow-package-link",
    setup(nitro) {
      const target = join(nitro.options.rootDir, "node_modules", "workflow")
      let ownsLink = false
      const unlink = () => {
        if (ownsLink) rmSync(target, { force: true })
        ownsLink = false
      }
      nitro.hooks.hook("build:before", async () => {
        if (existsSync(target)) return
        const source = dirname(dirname(dirname(createRequire(import.meta.url).resolve("workflow/internal/builtins"))))
        await mkdir(dirname(target), { recursive: true })
        await symlink(source, target, process.platform === "win32" ? "junction" : "dir")
        ownsLink = true
        process.once("exit", unlink)
      })
      nitro.hooks.hook("close", unlink)
    },
  }
}

async function addVercelWorkflowModule(nitro: Record<string, unknown>, entries: WorkflowNitroEntries, vite: boolean): Promise<Record<string, unknown>> {
  let workflowNitro: WorkflowNitroModule
  try {
    // SAFETY: `workflow/nitro` default-exports a Nitro module with a name and a setup function.
    workflowNitro = (await import("workflow/nitro")).default as WorkflowNitroModule
  }
  catch (error) {
    throw workflowErrorDiagnostics.WORKFLOW_R0006({ message: `Native Vercel workflows require the optional workflow peer dependency. ${error instanceof Error ? error.message : String(error)}` })
  }
  const modules = Array.isArray(nitro.modules) ? [...nitro.modules] : []
  // The link module must run its `build:before` hook before the Workflow builder.
  for (const module of [createWorkflowPackageLinkModule(), workflowNitro]) {
    if (!modules.some(candidate => candidate === module || record(candidate).name === module.name)) modules.push(module)
  }
  const options = record(nitro.workflow)
  const dirs = [...new Set([
    ...(Array.isArray(options.dirs) ? options.dirs.filter((dir): dir is string => typeof dir === "string") : []),
    ...entries.definitions.map(definition => dirname(definition.handler)),
    ...entries.vercelNativeFiles.map(file => dirname(file)),
  ])]
  return {
    ...nitro,
    modules,
    // Vercel Workflow builds the `"use workflow"` functions in these directories into Nitro routes.
    workflow: { ...options, dirs, ...(vite ? { _vite: true } : {}) },
  }
}

/** Adds the Workflow registry, Cloudflare Workflow classes, and Vercel Workflow routes to a Nitro config. */
export async function createWorkflowNitroConfig(options: WorkflowNitroConfigOptions): Promise<Record<string, unknown>> {
  const preset = typeof options.nitro.preset === "string" ? options.nitro.preset : options.hosting ?? ""
  const config = normalizeWorkflowOptions(options.workflow, { hosting: preset })
  if (!config) return options.nitro
  const entries = await writeWorkflowNitroEntries(options.rootDir, config, options)
  const kit = createNitroServerKit(options.nitro)
  kit.addPlugin(entries.pluginFile, "start")
  kit.addHandler({ handler: entries.middlewareFile, middleware: true, route: "/**" }, "start")
  let nitro = kit.config
  if (config.provider === "cloudflare" && entries.providerDefinitions.length) nitro = addCloudflareWorkflows(nitro, entries, config)
  if (entries.vercelNative) nitro = await addVercelWorkflowModule(nitro, entries, options.vite === true)
  return nitro
}
