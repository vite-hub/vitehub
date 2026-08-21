import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { cloudflareRuntimeExternal, defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { getAgentInvocationRecoveryWorkflowName } from "@vite-hub/internal/agent-workflow"
import { readColocatedAgentFiles } from "@vite-hub/internal/build/colocated-agent-files"
import { createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, withProviderDeploymentOutputLock } from "@vite-hub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { VITEHUB_MODES, getViteMode } from "@vite-hub/internal/build/mode"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import { buildSync } from "esbuild"
import type { Plugin } from "esbuild"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName } from "../integrations/cloudflare.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions, WorkflowModuleOptions, WorkflowProvider } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, ProviderDeploymentOutputOptions, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as VitePlugin } from "vite"

export const workflowPackageName = "@vite-hub/workflow"
const productName = "workflow"
const vercelNativeWorkflowOwnershipMarker = ".vitehub-owned"
const vercelWorkflowFunctionOwnershipMarker = ".vitehub-workflow-output.json"
const vercelWorkflowOutputState = ".vitehub/workflow/vercel-output.json"

interface VercelNativeWorkflowOwnership {
  cleanup?: boolean
  files: Record<string, string>
  routes: string[]
  version: 1
}

interface VercelNativeWorkflowState {
  files: Record<string, string>
  ownership?: VercelNativeWorkflowOwnership
  routes: unknown[]
}

interface VercelNativeWorkflowSnapshot {
  config?: Buffer
  files: Record<string, Buffer>
}

interface VercelWorkflowFunctionOwnership {
  digest: string
  rootConfigRoutes?: string[]
  version: 1
}

interface VercelWorkflowOutputState {
  rootConfigRoutes?: string[]
  serverFunctionName: string
  version: 1
}

const vercelRootWorkflowRoutes = [
  { handle: "filesystem" },
  { src: "/(.*)", dest: "/__server" },
].map(route => JSON.stringify(route))

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(temporaryFile, file)
  }
  finally {
    await rm(temporaryFile, { force: true })
  }
}

async function readVercelNativeWorkflowOwnership(ownershipFile: string): Promise<VercelNativeWorkflowOwnership | undefined> {
  try {
    const ownership = JSON.parse(await readFile(ownershipFile, "utf8")) as VercelNativeWorkflowOwnership
    if (ownership.version !== 1 || !ownership.files || !Array.isArray(ownership.routes)) return
    if (Object.entries(ownership.files).some(([file, digest]) => isAbsolute(file) || typeof digest !== "string")) return
    if (ownership.routes.some(route => typeof route !== "string")) return
    return ownership
  }
  catch {
    return
  }
}

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

export function createOptionalViteDevtoolsPlugin(rootDir: string): Plugin {
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

export async function createVercelWorkflowTransformPlugin(rootDir: string): Promise<Plugin | undefined> {
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
        throw new Error(`Native Vercel workflow entry ${JSON.stringify(relative(rootDir, file))} must be colocated with its discovered workflow definition.`)
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

export async function installEmailDefinitionInVercelWorkflowOutput(rootDir: string, emailDefinitionFile: string): Promise<void> {
  // WDK's Vercel builder emits step registrations and workflow orchestration in one combined flow function.
  const flowFile = resolve(rootDir, ".vercel", "output", "functions", ".well-known", "workflow", "v1", "flow.func", "index.mjs")
  if (!existsSync(flowFile)) return
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  const bootstrapEntry = resolve(generatedDir, "email-workflow-bootstrap.entry.mjs")
  const workflowBundle = resolve(generatedDir, "email-workflow-bootstrap.source.mjs")
  try {
    await mkdir(generatedDir, { recursive: true })
    await writeFile(workflowBundle, await readFile(flowFile, "utf8"), "utf8")
    await writeFile(bootstrapEntry, [
      `import viteHubEmailDefinition from ${JSON.stringify(createImportPath(bootstrapEntry, emailDefinitionFile))}`,
      `import * as workflowModule from ${JSON.stringify(createImportPath(bootstrapEntry, workflowBundle))}`,
      `globalThis[Symbol.for("vitehub.email.definition")] = viteHubEmailDefinition`,
      "export default workflowModule.default",
      `export * from ${JSON.stringify(createImportPath(bootstrapEntry, workflowBundle))}`,
      "",
    ].join("\n"), "utf8")
    await bundleEsmEntry(bootstrapEntry, flowFile, {
      external: ["@aws-sdk/credential-provider-web-identity"],
      format: "esm",
      platform: "node",
      rootDir,
    })
  }
  finally {
    await rm(bootstrapEntry, { force: true })
    await rm(workflowBundle, { force: true })
  }
}

export async function cleanVercelNativeWorkflowOutput(rootDir: string): Promise<void> {
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const workflowRoot = resolve(outputRoot, "functions", ".well-known", "workflow")
  const ownershipFile = resolve(workflowRoot, vercelNativeWorkflowOwnershipMarker)
  const ownership = await readVercelNativeWorkflowOwnership(ownershipFile)
  if (!ownership) return
  if (Object.keys(ownership.files).some(file => relative(workflowRoot, resolve(workflowRoot, file)).startsWith(".."))) return

  let hasReplacement = false
  const ownedFiles: string[] = []
  for (const [file, digest] of Object.entries(ownership.files)) {
    const outputFile = resolve(workflowRoot, file)
    let contents: Buffer
    try {
      contents = await readFile(outputFile)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!ownership.cleanup) hasReplacement = true
        continue
      }
      throw error
    }
    if (createHash("sha256").update(contents).digest("hex") !== digest) {
      hasReplacement = true
      continue
    }
    ownedFiles.push(outputFile)
  }
  if (hasReplacement) {
    await rm(ownershipFile, { force: true })
    return
  }
  if (!ownership.cleanup) await writeFile(ownershipFile, `${JSON.stringify({ ...ownership, cleanup: true }, null, 2)}\n`, "utf8")
  await Promise.all(ownedFiles.map(async file => await rm(file, { force: true })))
  const configFile = resolve(outputRoot, "config.json")
  let config: { routes?: Array<Record<string, unknown>>, [key: string]: unknown } | undefined
  try {
    config = JSON.parse(await readFile(configFile, "utf8"))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (Array.isArray(config?.routes)) {
    const ownedRoutes = new Set(ownership.routes)
    const routes = config.routes.filter(route => !ownedRoutes.has(JSON.stringify(route)))
    if (routes.length !== config.routes.length) {
      await writeFile(configFile, `${JSON.stringify({ ...config, routes }, null, 2)}\n`, "utf8")
    }
  }
  await rm(ownershipFile, { force: true })
  await removeEmptyDirectories(workflowRoot)
}

async function removeEmptyDirectories(directory: string): Promise<boolean> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(resolve(directory, entry.name))
  }
  if ((await readdir(directory)).length) return false
  await rmdir(directory)
  return true
}

async function collectVercelNativeWorkflowFiles(workflowRoot: string, directory = workflowRoot): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const outputFile = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, await collectVercelNativeWorkflowFiles(workflowRoot, outputFile))
    }
    else if (entry.name !== vercelNativeWorkflowOwnershipMarker) {
      files[relative(workflowRoot, outputFile).replaceAll("\\", "/")] = createHash("sha256").update(await readFile(outputFile)).digest("hex")
    }
  }
  return files
}

async function snapshotVercelNativeWorkflowOutput(rootDir: string): Promise<VercelNativeWorkflowSnapshot> {
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const workflowRoot = resolve(outputRoot, "functions", ".well-known", "workflow")
  const files: Record<string, Buffer> = {}
  const collect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) await collect(file)
      else files[relative(workflowRoot, file)] = await readFile(file)
    }
  }
  if (existsSync(workflowRoot)) await collect(workflowRoot)
  let config: Buffer | undefined
  try {
    config = await readFile(resolve(outputRoot, "config.json"))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return { config, files }
}

async function restoreVercelNativeWorkflowOutput(rootDir: string, snapshot: VercelNativeWorkflowSnapshot): Promise<void> {
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const workflowRoot = resolve(outputRoot, "functions", ".well-known", "workflow")
  await rm(workflowRoot, { force: true, recursive: true })
  await Promise.all(Object.entries(snapshot.files).map(async ([file, contents]) => {
    const outputFile = resolve(workflowRoot, file)
    await mkdir(dirname(outputFile), { recursive: true })
    await writeFile(outputFile, contents)
  }))
  const configFile = resolve(outputRoot, "config.json")
  if (snapshot.config) {
    await mkdir(outputRoot, { recursive: true })
    await writeFile(configFile, snapshot.config)
  }
  else await rm(configFile, { force: true })
}

async function readVercelNativeWorkflowState(rootDir: string): Promise<VercelNativeWorkflowState> {
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const workflowRoot = resolve(outputRoot, "functions", ".well-known", "workflow")
  let routes: unknown[] = []
  try {
    const config = JSON.parse(await readFile(resolve(outputRoot, "config.json"), "utf8")) as { routes?: unknown[] }
    routes = config.routes ?? []
  }
  catch {}
  return {
    files: existsSync(workflowRoot) ? await collectVercelNativeWorkflowFiles(workflowRoot) : {},
    ownership: await readVercelNativeWorkflowOwnership(resolve(workflowRoot, vercelNativeWorkflowOwnershipMarker)),
    routes,
  }
}

function assertNoExternalCanonicalWorkflowOutput(state: VercelNativeWorkflowState): void {
  const externalCanonicalFiles = Object.entries(state.files)
    .filter(([file, digest]) => /^v1\/(?:flow|step)\.func\/|^v1\/webhook\//.test(file) && state.ownership?.files[file] !== digest)
    .map(([file]) => file)
  if (externalCanonicalFiles.length) {
    throw new Error(`Native Vercel Workflow output conflicts with existing unowned Workflow DevKit functions: ${externalCanonicalFiles.join(", ")}. Build all native Workflow source directories together.`)
  }
}

async function buildVercelNativeWorkflowOutput(rootDir: string, definitions: DiscoveredWorkflowDefinition[], aliases: Record<string, string> = {}, nativeFiles: string[] = [], previousState?: VercelNativeWorkflowState): Promise<void> {
  if (!hasVercelNativeWorkflowEntry(rootDir, definitions, aliases, nativeFiles)) {
    await cleanVercelNativeWorkflowOutput(rootDir)
    return
  }
  const builders = await loadVercelWorkflowBuilders()
  if (!builders) {
    throw new Error("Native Vercel workflows require the optional workflow and @workflow/builders peer dependencies.")
  }

  const snapshot = await snapshotVercelNativeWorkflowOutput(rootDir)
  const outputConfigFile = resolve(rootDir, ".vercel", "output", "config.json")
  const viteHubConfig = JSON.parse(await readFile(outputConfigFile, "utf8")) as { routes?: unknown[] }
  const workflowRoot = resolve(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const previousOwnership = previousState?.ownership
  const previousFiles = previousState?.files ?? {}
  if (previousState) assertNoExternalCanonicalWorkflowOutput(previousState)
  const previouslyOwnedRoutes = new Set(previousOwnership?.routes ?? [])
  const preservedRoutes = (previousState?.routes ?? []).filter(route => JSON.stringify(route).includes("/.well-known/workflow/v1/") && !previouslyOwnedRoutes.has(JSON.stringify(route)))
  const currentRoutes = (viteHubConfig.routes ?? []).filter(route => !previouslyOwnedRoutes.has(JSON.stringify(route)))
  const viteHubRoutes = [...new Map([...currentRoutes, ...preservedRoutes].map(route => [JSON.stringify(route), route])).values()]
  const rollbackRoutes = [...new Map([
    ...currentRoutes,
    ...(previousState?.routes ?? []).filter(route => JSON.stringify(route).includes("/.well-known/workflow/v1/")),
  ].map(route => [JSON.stringify(route), route])).values()]
  snapshot.config = Buffer.from(`${JSON.stringify({ ...viteHubConfig, routes: rollbackRoutes }, null, 2)}\n`)
  const externalWorkflowRoutes = new Set(preservedRoutes
    .filter(route => JSON.stringify(route).includes("/.well-known/workflow/v1/"))
    .map(route => JSON.stringify(route)))
  const definitionDirs = [...new Set([
    ...definitions.map(definition => dirname(definition.handler)),
    ...nativeFiles.map(file => dirname(file)),
  ])]
  const builder = new builders.VercelBuildOutputAPIBuilder({
    buildTarget: "vercel-build-output-api",
    dirs: definitionDirs,
    projectRoot: rootDir,
    stepsBundlePath: "./.well-known/workflow/v1/step.js",
    webhookBundlePath: "./.well-known/workflow/v1/webhook.js",
    workflowsBundlePath: "./.well-known/workflow/v1/flow.js",
    workingDir: rootDir,
  })
  try {
    await withVercelWorkflowPackageLink(rootDir, async () => await builder.build())
    const emailDefinitionFile = aliases["#vitehub/email/definition"]
    if (emailDefinitionFile) await installEmailDefinitionInVercelWorkflowOutput(rootDir, emailDefinitionFile)
    const workflowConfig = JSON.parse(await readFile(outputConfigFile, "utf8")) as { routes?: unknown[], [key: string]: unknown }
    await writeFile(outputConfigFile, `${JSON.stringify({
      ...workflowConfig,
      ...viteHubConfig,
      routes: [...(workflowConfig.routes ?? []), ...viteHubRoutes],
    }, null, 2)}\n`, "utf8")
    const generatedFiles = await collectVercelNativeWorkflowFiles(workflowRoot)
    const ownedFiles = Object.fromEntries(Object.entries(generatedFiles)
      .filter(([file, digest]) => previousFiles[file] !== digest || previousFiles[file] === previousOwnership?.files[file]))
    const routeTargetsOwnedFunction = (route: unknown) => {
      if (!route || typeof route !== "object") return false
      return ["dest", "src"]
        .map(key => (route as Record<string, unknown>)[key])
        .filter((value): value is string => typeof value === "string")
        .some((target) => {
          const functionPath = target.match(/\/\.well-known\/workflow\/(v1\/[^?]+)/)?.[1]
          return Boolean(functionPath && Object.keys(ownedFiles).some(file => file.startsWith(`${functionPath}.func/`)))
        })
    }
    const ownership: VercelNativeWorkflowOwnership = {
      files: ownedFiles,
      routes: [...new Map([...(workflowConfig.routes ?? []), ...preservedRoutes].map(route => [JSON.stringify(route), route])).values()]
        .filter(route => JSON.stringify(route).includes("/.well-known/workflow/v1/"))
        .filter(route => !externalWorkflowRoutes.has(JSON.stringify(route)) || routeTargetsOwnedFunction(route))
        .map(route => JSON.stringify(route)),
      version: 1,
    }
    await writeFile(resolve(workflowRoot, vercelNativeWorkflowOwnershipMarker), `${JSON.stringify(ownership, null, 2)}\n`, "utf8")
  }
  catch (error) {
    await restoreVercelNativeWorkflowOutput(rootDir, snapshot)
    throw error
  }
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
  vercelNativeFiles: string[]
  vercelServerFile: string
}

interface GenerateProviderOutputsOptions {
  agentImportBase?: string
  clientOutDir: string
  hosting?: string
  importBase?: string
  providerImportAliases?: Record<string, string>
  providerRuntimeImportAliases?: Partial<Record<WorkflowProvider, Record<string, string>>>
  definitionRootDir?: string
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

function renderAgentWorkflowRegistryEntry(registryFile: string, definition: DiscoveredWorkflowDefinition) {
  return [
    `  ${JSON.stringify(definition.name)}: async () => {`,
    `    const cached = registryEntryCache.get(${JSON.stringify(definition.name)})`,
    "    if (cached) return cached",
    `    const loaded = await ${renderRegistryImport(registryFile, definition.handler)}`,
    `    const agent = agentWithColocatedSkills(workspaceAgentWithSourceRoot(agentWithColocatedInstructions("default" in loaded ? loaded.default : loaded, ${JSON.stringify(readAgentInstructions(definition.handler))}), ${JSON.stringify(resolveAgentWorkspaceSourceRoot(definition.handler))}, ${JSON.stringify(readAgentInstructions(definition.handler))}), ${JSON.stringify(readAgentSkills(definition.handler))})`,
    `    const entry = { options: { rootStep: false }, handler: async (context) => await runAgentWorkflowDefinition(agent, { ...context, payload: { ...context.payload, agentIdentity: context.payload?.agentIdentity || { name: ${JSON.stringify(definition.agentIdentity || definition.name)} } } }, runAgentInline)${definition.source === "agent-workflow-recovery" ? ", internalAgentInvocationRecovery: true" : ""} }`,
    `    registryEntryCache.set(${JSON.stringify(definition.name)}, entry)`,
    "    return entry",
    "  },",
  ].join("\n")
}

function getGeneratedVercelWorkflowExport(definition: DiscoveredWorkflowDefinition): string | undefined {
  if (!definition.steps?.length || /\.(?:c|m)?[jt]s$/i.test(definition.handler)) return
  return `${getCloudflareWorkflowClassName(definition.name)}Native`
}

function createVercelNativeWorkflowContents(
  nativeFile: string,
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
    imports.push(`import ${implementation} from ${JSON.stringify(createImportPath(nativeFile, step))}`)
    workflows.push(`async function ${name}(input) {\n  "use step"\n  return await ${implementation}(input)\n}`)
    return name
  })
  workflows.push(`export async function ${workflowExport}(context) {\n  "use workflow"\n  let value = context.payload\n${stepNames.map(name => `  value = await ${name}(value)`).join("\n")}\n  return value\n}`)
  return [...imports, "", ...workflows, ""].join("\n")
}

function renderWorkflowRegistryEntry(registryFile: string, definition: DiscoveredWorkflowDefinition, vercelNativeFiles: Record<string, string> = {}) {
  if (definition.source === "agent-workflow" || definition.source === "agent-workflow-recovery") {
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
  const nativeExport = getGeneratedVercelWorkflowExport(definition)
  const vercelNativeFile = vercelNativeFiles[definition.name]
  const nativeImport = nativeExport && vercelNativeFile
    ? `const native = (await ${renderRegistryImport(registryFile, vercelNativeFile)}).${nativeExport}\n    native.workflowId ||= ${JSON.stringify(`workflow//./.vitehub/workflow/vercel-native//${nativeExport}`)}`
    : ""
  const handler = hasIndex
    ? `index.default?.handler ? index.default : takeInlineWorkflowDefinitionForModule(${JSON.stringify(definition.name)}, index) || { handler: index.default }`
    : "{ handler: async (context) => { let value = context.payload; for (const step of Object.values(context.steps || {})) value = await step(value); return value } }"

  return [
    `  ${JSON.stringify(definition.name)}: async () => {`,
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

function createWorkflowRegistryContents(
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
    ...definitions.map(definition => renderWorkflowRegistryEntry(registryFile, definition, vercelNativeFiles)),
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

export async function writeProviderEntries(
  rootDir: string,
  workflow: WorkflowModuleOptions | undefined,
  importBases: WorkflowImportBases = {},
  serverDirs?: string[],
  includeUserAppEntry = true,
  transformRegistry?: (code: string, id: string) => string | Promise<string>,
  definitionRootDir = rootDir,
) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverWorkflowDefinitions({ rootDir: definitionRootDir, serverDirs })
  const definitionNames = new Set(definitions.map(definition => definition.name))
  for (const definition of definitions) {
    if (definition.source !== "agent-workflow") continue
    const recoveryName = getAgentInvocationRecoveryWorkflowName(definition.name)
    if (definitionNames.has(recoveryName)) {
      throw new Error(`Workflow name ${JSON.stringify(recoveryName)} conflicts with the generated Agent invocation recovery Workflow for ${JSON.stringify(definition.name)}.`)
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
  const userAppEntry = includeUserAppEntry ? resolveWorkflowUserAppEntry(definitionRootDir) : undefined
  const cloudflareWorkflowConfig = resolveWorkflowConfig(workflow, "cloudflare")

  const vercelNativeDir = resolve(generatedDir, "vercel-native")
  const nativeDefinitions = definitions.filter(definition => getGeneratedVercelWorkflowExport(definition))
  await rm(resolve(generatedDir, "vercel-native.mjs"), { force: true })
  await rm(vercelNativeDir, { force: true, recursive: true })
  const vercelNativeFiles = Object.fromEntries(nativeDefinitions.map(definition => [
    definition.name,
    resolve(vercelNativeDir, `${createHash("sha256").update(definition.name).digest("hex")}.mjs`),
  ]))
  if (nativeDefinitions.length) await mkdir(vercelNativeDir, { recursive: true })
  await Promise.all(nativeDefinitions.map(async definition => {
    const nativeFile = vercelNativeFiles[definition.name]
    await writeFile(nativeFile, createVercelNativeWorkflowContents(nativeFile, definition), "utf8")
  }))
  const registryContents = createWorkflowRegistryContents(
    registryFile,
    providerDefinitions,
    importBases,
    vercelNativeFiles,
  )
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
    vercelNativeFiles: Object.values(vercelNativeFiles),
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
        cloudflareRuntimeExternal,
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

function isSafeVercelFunctionName(functionsRoot: string, serverFunctionName: string): boolean {
  const path = relative(functionsRoot, resolve(functionsRoot, serverFunctionName))
  return Boolean(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path)
}

async function readVercelWorkflowFunctionOwnership(functionRoot: string): Promise<VercelWorkflowFunctionOwnership | undefined> {
  try {
    const ownership = JSON.parse(await readFile(resolve(functionRoot, vercelWorkflowFunctionOwnershipMarker), "utf8")) as Partial<VercelWorkflowFunctionOwnership>
    if (typeof ownership.digest !== "string") return
    if (ownership.version !== undefined && ownership.version !== 1) return
    if (ownership.rootConfigRoutes !== undefined && (!Array.isArray(ownership.rootConfigRoutes) || ownership.rootConfigRoutes.some(route => typeof route !== "string"))) return
    return {
      digest: ownership.digest,
      ...(ownership.rootConfigRoutes ? { rootConfigRoutes: ownership.rootConfigRoutes } : {}),
      version: 1,
    }
  }
  catch {
    return
  }
}

async function isLegacyVercelWorkflowFunction(functionRoot: string): Promise<boolean> {
  try {
    const [contents, functionConfig] = await Promise.all([
      readFile(resolve(functionRoot, "index.mjs"), "utf8"),
      readFile(resolve(functionRoot, ".vc-config.json"), "utf8").then(value => JSON.parse(value) as Record<string, unknown>),
    ])
    return contents.includes("function createWorkflowVercelServer(")
      && contents.includes("setWorkflowRuntimeRegistry(options.registry)")
      && functionConfig.handler === "index.mjs"
      && functionConfig.launcherType === "Nodejs"
      && typeof functionConfig.runtime === "string"
      && /^nodejs\d+\.x$/.test(functionConfig.runtime)
      && functionConfig.shouldAddHelpers === false
      && functionConfig.supportsResponseStreaming === true
  }
  catch {
    return false
  }
}

async function getVercelWorkflowFunctionOwnership(functionRoot: string, legacy: boolean): Promise<VercelWorkflowFunctionOwnership | undefined> {
  const ownership = await readVercelWorkflowFunctionOwnership(functionRoot)
  if (ownership) {
    try {
      const digest = createHash("sha256").update(await readFile(resolve(functionRoot, "index.mjs"))).digest("hex")
      return digest === ownership.digest ? ownership : undefined
    }
    catch {
      return
    }
  }
  if (!legacy || !await isLegacyVercelWorkflowFunction(functionRoot)) return
  return {
    digest: createHash("sha256").update(await readFile(resolve(functionRoot, "index.mjs"))).digest("hex"),
    ...(functionRoot.endsWith("__server.func") ? { rootConfigRoutes: vercelRootWorkflowRoutes } : {}),
    version: 1,
  }
}

async function readVercelWorkflowOutputState(rootDir: string, functionsRoot: string): Promise<VercelWorkflowOutputState | undefined> {
  try {
    const state = JSON.parse(await readFile(resolve(rootDir, vercelWorkflowOutputState), "utf8")) as Partial<VercelWorkflowOutputState>
    if (typeof state.serverFunctionName !== "string" || !isSafeVercelFunctionName(functionsRoot, state.serverFunctionName)) return
    if (state.version !== undefined && state.version !== 1) return
    if (state.rootConfigRoutes !== undefined && (!Array.isArray(state.rootConfigRoutes) || state.rootConfigRoutes.some(route => typeof route !== "string"))) return
    return {
      ...(state.rootConfigRoutes ? { rootConfigRoutes: state.rootConfigRoutes } : {}),
      serverFunctionName: state.serverFunctionName,
      version: 1,
    }
  }
  catch {
    return
  }
}

async function cleanVercelWorkflowRootConfig(rootDir: string, ownedRoutes: string[]): Promise<void> {
  if (!ownedRoutes.length) return
  const configFile = resolve(createDefaultVercelOutputRoot(rootDir), "config.json")
  let config: Record<string, unknown>
  try {
    const value = JSON.parse(await readFile(configFile, "utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    config = value as Record<string, unknown>
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!Array.isArray(config.routes)) return

  const pendingRoutes = [...ownedRoutes]
  const routes = config.routes.filter((route) => {
    const index = pendingRoutes.indexOf(JSON.stringify(route))
    if (index < 0) return true
    pendingRoutes.splice(index, 1)
    return false
  })
  if (routes.length === config.routes.length) return

  const next = { ...config }
  if (routes.length) next.routes = routes
  else delete next.routes
  if (next.version === 3 && Object.keys(next).length === 1) delete next.version
  if (Object.keys(next).length) await writeJsonAtomically(configFile, next)
  else await rm(configFile, { force: true })
}

async function updateVercelWorkflowFunctionOwnership(rootDir: string, activeServerFunctionName: string | undefined, ownsRootConfig: boolean): Promise<void> {
  const functionsRoot = resolve(createDefaultVercelOutputRoot(rootDir), "functions")
  const candidates = new Set(["__server.func", "__workflow.func"])
  const previousOutput = await readVercelWorkflowOutputState(rootDir, functionsRoot)
  if (previousOutput) candidates.add(previousOutput.serverFunctionName)
  if (activeServerFunctionName) candidates.add(activeServerFunctionName)
  try {
    for (const entry of await readdir(functionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(resolve(functionsRoot, entry.name, vercelWorkflowFunctionOwnershipMarker))) candidates.add(entry.name)
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const removedRootConfigRoutes: string[] = []
  const removedFunctionRoots: string[] = []
  for (const serverFunctionName of candidates) {
    if (serverFunctionName === activeServerFunctionName || !isSafeVercelFunctionName(functionsRoot, serverFunctionName)) continue
    const functionRoot = resolve(functionsRoot, serverFunctionName)
    const ownership = await getVercelWorkflowFunctionOwnership(functionRoot, serverFunctionName === "__server.func" || serverFunctionName === "__workflow.func")
    if (!ownership) continue
    removedRootConfigRoutes.push(...(ownership.rootConfigRoutes ?? (previousOutput?.serverFunctionName === serverFunctionName ? previousOutput.rootConfigRoutes ?? [] : [])))
    removedFunctionRoots.push(functionRoot)
  }
  const stateFile = resolve(rootDir, vercelWorkflowOutputState)
  if (!activeServerFunctionName) {
    await cleanVercelWorkflowRootConfig(rootDir, removedRootConfigRoutes)
    await Promise.all(removedFunctionRoots.map(functionRoot => rm(functionRoot, { force: true, recursive: true })))
    await rm(stateFile, { force: true })
    return
  }

  const functionRoot = resolve(functionsRoot, activeServerFunctionName)
  const digest = createHash("sha256").update(await readFile(resolve(functionRoot, "index.mjs"))).digest("hex")
  const rootConfigRoutes = ownsRootConfig ? vercelRootWorkflowRoutes : undefined
  await writeJsonAtomically(resolve(functionRoot, vercelWorkflowFunctionOwnershipMarker), {
    digest,
    ...(rootConfigRoutes ? { rootConfigRoutes } : {}),
    version: 1,
  } satisfies VercelWorkflowFunctionOwnership)
  await writeJsonAtomically(stateFile, {
    ...(rootConfigRoutes ? { rootConfigRoutes } : {}),
    serverFunctionName: activeServerFunctionName,
    version: 1,
  } satisfies VercelWorkflowOutputState)
  await cleanVercelWorkflowRootConfig(rootDir, removedRootConfigRoutes)
  await Promise.all(removedFunctionRoots.map(functionRoot => rm(functionRoot, { force: true, recursive: true })))
}

async function generateProviderOutputsWithinLock(
  options: GenerateProviderOutputsOptions,
  writeProviderDeploymentOutputs: (options: ProviderDeploymentOutputOptions) => Promise<void>,
): Promise<GeneratedWorkflowArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.workflow, {
    agent: options.agentImportBase,
    workflow: options.importBase,
    workspace: options.workspaceImportBase,
    workspaceDependencies: options.workspaceDependencyRuntimeImports,
  }, options.serverDirs, options.includeUserAppEntry, options.transformRegistry, options.definitionRootDir)
  const inferredWorkflowConfig = options.hosting
    ? resolveWorkflowConfig(options.workflow, options.hosting)
    : undefined
  const cloudflareWorkflowConfig = inferredWorkflowConfig === undefined
    ? resolveWorkflowConfig(options.workflow, "cloudflare")
    : inferredWorkflowConfig && inferredWorkflowConfig.provider === "cloudflare"
      ? inferredWorkflowConfig
      : false
  const vercelWorkflowConfig = inferredWorkflowConfig === undefined
    ? resolveWorkflowConfig(options.workflow, "vercel")
    : inferredWorkflowConfig && inferredWorkflowConfig.provider === "vercel"
      ? inferredWorkflowConfig
      : false
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
    const previousNativeOutput = await readVercelNativeWorkflowState(options.rootDir)
    if (vercelOutput && hasVercelNativeWorkflowEntry(options.rootDir, artifacts.providerDefinitions, {
      ...options.providerImportAliases,
      ...options.providerRuntimeImportAliases?.vercel,
    }, artifacts.vercelNativeFiles)) {
      assertNoExternalCanonicalWorkflowOutput(previousNativeOutput)
    }
    try {
      await writeProviderDeploymentOutputs({
        clientOutDir: options.clientOutDir,
        cloudflare: cloudflareOutput,
        cleanup: {
          cloudflare: cloudflareOutput ? undefined : () => createCloudflareWorkflowCleanup(options.rootDir),
        },
        afterWrite: async () => {
          if (vercelOutput) {
            await buildVercelNativeWorkflowOutput(options.rootDir, artifacts.providerDefinitions, {
              ...options.providerImportAliases,
              ...options.providerRuntimeImportAliases?.vercel,
            }, artifacts.vercelNativeFiles, previousNativeOutput)
          }
          else {
            await cleanVercelNativeWorkflowOutput(options.rootDir)
          }
          await updateVercelWorkflowFunctionOwnership(options.rootDir, vercelOutput ? options.serverFunctionName ?? "__server.func" : undefined, Boolean(vercelOutput && !options.serverFunctionName))
        },
        rootDir: options.rootDir,
        ...(vercelOutput ? { vercel: vercelOutput } : {}),
      })
    }
    catch (error) {
      if (vercelOutput) {
        const serverFunctionName = options.serverFunctionName ?? "__server.func"
        await rm(resolve(createDefaultVercelOutputRoot(options.rootDir), "functions", serverFunctionName), { force: true, recursive: true })
        if (!options.serverFunctionName) await cleanVercelWorkflowRootConfig(options.rootDir, vercelRootWorkflowRoutes)
      }
      throw error
    }
  }
  if (workflowTransformPlugin && options.importBase) await withVercelWorkflowPackageLink(options.rootDir, writeOutputs)
  else await writeOutputs()
  return artifacts
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedWorkflowArtifacts> {
  return await withProviderDeploymentOutputLock(options.rootDir, async write => await generateProviderOutputsWithinLock(options, write))
}
