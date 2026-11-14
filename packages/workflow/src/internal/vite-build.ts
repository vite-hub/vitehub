import { isRuntimeRecord } from "./runtime-type.ts"
import { workflowRuntimeModule, type WorkflowRuntimeModuleName } from "./runtime-modules.ts"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { builtinModules, createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { cloudflareRuntimeExternal, defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { getAgentInvocationRecoveryWorkflowName } from "@vite-hub/internal/agent-workflow"
import { readColocatedAgentFiles, resolveColocatedAgentFilesRoot } from "@vite-hub/internal/build/colocated-agent-files"
import { createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, withProviderDeploymentOutputLock } from "@vite-hub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { createImportPath, ensureGeneratedDir } from "@vite-hub/internal/build/paths"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { publishProviderSourcesToDeploymentOutputs, rebasePublishedProviderSourceLinks, removeProviderOutputArtifactDir, rewriteRetainedProviderSourcePaths } from "@vite-hub/internal/build/provider-output-sources"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { buildSync, transform } from "esbuild"
import type { Plugin } from "esbuild"

import { normalizeWorkflowOptions } from "../config.ts"
import { discoverWorkflowDefinitions } from "../discovery.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowClassName, getLegacyCloudflareWorkflowClassName } from "../integrations/cloudflare.ts"

import type { DiscoveredWorkflowDefinition, ResolvedWorkflowOptions, WorkflowOptions, WorkflowProvider } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, ProviderDeploymentOutputOptions, ProviderDeploymentOutputWriter, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"
import type { VercelFunctionRuntimePackage } from "@vite-hub/internal/build/vercel-runtime-packages"
import type { Plugin as VitePlugin } from "vite"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

export function resolveVercelWorkflowWorld(workflowApi: string): string {
  const workflowCore = createRequire(workflowApi).resolve("@workflow/core")
  return createRequire(workflowCore).resolve("@workflow/world-vercel")
}

export const workflowPackageName = "@vite-hub/workflow"
const productName = "workflow"
const vercelNativeWorkflowOwnershipMarker = ".vitehub-owned"
const vercelWorkflowFunctionOwnershipMarker = ".vitehub-workflow-output.json"
const vercelWorkflowOutputState = ".vitehub/workflow/vercel-output.json"
const deployedWorkflowSourcesPath = ".vitehub/workflow/sources"

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

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!isRuntimeRecord(value)) throw workflowErrorDiagnostics.WORKFLOW_R0003({ message: `Expected ${label} to contain a JSON record.` })
  return value
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
    const value = parseJsonRecord(await readFile(ownershipFile, "utf8"), "Vercel Workflow ownership")
    if (value.version !== 1 || !isRuntimeRecord(value.files) || !Array.isArray(value.routes)) return
    if (value.cleanup !== undefined && typeof value.cleanup !== "boolean") return
    const files: Record<string, string> = {}
    for (const [file, digest] of Object.entries(value.files)) {
      if (isAbsolute(file) || typeof digest !== "string") return
      files[file] = digest
    }
    if (value.routes.some(route => typeof route !== "string")) return
    return {
      ...(value.cleanup === true ? { cleanup: true } : {}),
      files,
      routes: value.routes.filter((route): route is string => typeof route === "string"),
      version: 1,
    }
  }
  catch {
    return
  }
}

const generatedRegistryFileName = "registry.mjs"
/** Holds the definition loaders and their runtime setup. The registry index imports it on the first run. */
const generatedRegistryRuntimeFileName = "registry-runtime.mjs"
const cloudflareWorkflowWranglerConfigKeys = ["compatibility_date", "compatibility_flags", "main", "observability", "workflows"]
const cloudflareWorkflowWrapperImport = `import worker, { runViteHubWorkflowDefinition } from "./worker.mjs"`
const nodeBuiltinExternals = [...new Set(["node:*", ...builtinModules, ...builtinModules.map(module => `node:${module}`)])]
const optionalAgentRuntimeExternals = ["@vite-hub/workspace", "@vite-hub/workspace/*"]
const optionalViteDevtoolsPattern = /^@vitejs\/devtools-(?:oxc|rolldown|vite|vitest)(?:\/.*)?$/
interface VercelWorkflowBuilders {
  VercelBuildOutputAPIBuilder: typeof import("@workflow/builders").VercelBuildOutputAPIBuilder
  applySwcTransform: typeof import("@workflow/builders").applySwcTransform
  createSwcPlugin: (options: { mode: "workflow", projectRoot: string }) => Plugin
  detectWorkflowPatterns: typeof import("@workflow/builders").detectWorkflowPatterns
  shouldTransformFile: typeof import("@workflow/builders").shouldTransformFile
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
          // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
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
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined
    throw error
  }
  // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
  return await import("@workflow/builders") as VercelWorkflowBuilders
}

export async function createVercelWorkflowTransformPlugin(rootDir: string): Promise<Plugin | undefined> {
  const builders = await loadVercelWorkflowBuilders()
  if (!builders) return undefined
  const plugin = builders.createSwcPlugin({ mode: "workflow", projectRoot: rootDir })
  // Workflow's own Rollup and Vite plugins run SWC only on files with Workflow code. The esbuild plugin runs it on every file.
  return {
    ...plugin,
    setup: build => plugin.setup({
      ...build,
      // Workflow and step IDs are paths relative to this directory. Match the native Workflow build, not the process directory.
      initialOptions: { ...build.initialOptions, absWorkingDir: rootDir },
      onLoad: (options, callback) => build.onLoad(options, async (args) => {
        const source = await readFile(args.path, "utf8")
        return builders.shouldTransformFile(args.path, builders.detectWorkflowPatterns(source)) ? await callback(args) : undefined
      }),
    }),
  }
}

/** Transforms one module of a server bundle. It returns `undefined` for a module without Workflow code. */
export type VercelWorkflowModuleTransform = (code: string, id: string) => Promise<{ code: string } | undefined>

/**
 * The Workflow DevKit transform for Nitro's server bundle on Vercel. It gives each `"use workflow"` function the
 * `workflowId` that `start()` needs. The IDs are paths relative to `rootDir`, as in the native Workflow build, so the
 * server starts the Workflows that the native functions hold. It uses the `step` mode, as Workflow DevKit's own Nitro
 * integration does, so the normal handler can still call a step function.
 */
export async function createVercelWorkflowModuleTransform(rootDir: string): Promise<VercelWorkflowModuleTransform | undefined> {
  const builders = await loadVercelWorkflowBuilders()
  if (!builders) return undefined
  const root = rootDir.replace(/\\/g, "/").replace(/\/$/, "")
  return async (code, id) => {
    const file = id.replace(/\\/g, "/")
    if (!builders.shouldTransformFile(file, builders.detectWorkflowPatterns(code))) return undefined
    const path = relative(root, file).replace(/\\/g, "/")
    // Workflow DevKit drops `..` segments for a file outside the project root.
    const filename = path.split("/").filter(segment => segment !== "..").join("/")
    const result = await builders.applySwcTransform(filename, code, "step", file, root)
    return { code: result.code }
  }
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
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
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
      // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
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
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
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
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(resolve(directory, entry.name))
  }
  try {
    await rmdir(directory)
  }
  catch (error) {
    // Another provider finalizer may create or remove the directory after its contents are visited.
    // SAFETY: Node filesystem failures expose their POSIX code through NodeJS.ErrnoException.
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOTEMPTY" || code === "EEXIST") return false
    if (code === "ENOENT") return true
    throw error
  }
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
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
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
    const config = parseJsonRecord(await readFile(resolve(outputRoot, "config.json"), "utf8"), "Vercel output config")
    routes = Array.isArray(config.routes) ? config.routes : []
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
    throw workflowErrorDiagnostics.WORKFLOW_R0005({ message: `Native Vercel Workflow output conflicts with existing unowned Workflow DevKit functions: ${externalCanonicalFiles.join(", ")}. Build all native Workflow source directories together.` })
  }
}

async function buildVercelNativeWorkflowOutput(rootDir: string, definitions: DiscoveredWorkflowDefinition[], aliases: Record<string, string> = {}, nativeFiles: string[] = [], previousState?: VercelNativeWorkflowState, bundleDefines: Record<string, string> = {}): Promise<void> {
  if (!hasVercelNativeWorkflowEntry(rootDir, definitions, aliases, nativeFiles)) {
    await cleanVercelNativeWorkflowOutput(rootDir)
    return
  }
  const builders = await loadVercelWorkflowBuilders()
  if (!builders) {
    throw workflowErrorDiagnostics.WORKFLOW_R0006({ message: "Native Vercel workflows require the optional workflow and @workflow/builders peer dependencies." })
  }

  const snapshot = await snapshotVercelNativeWorkflowOutput(rootDir)
  const outputConfigFile = resolve(rootDir, ".vercel", "output", "config.json")
  // Nitro writes its Vercel config after the native Workflow functions, so a Nitro build has none yet.
  const viteHubConfig = existsSync(outputConfigFile) ? parseJsonRecord(await readFile(outputConfigFile, "utf8"), "ViteHub Vercel output config") : {}
  const workflowRoot = resolve(rootDir, ".vercel", "output", "functions", ".well-known", "workflow")
  const previousOwnership = previousState?.ownership
  const previousFiles = previousState?.files ?? {}
  if (previousState) assertNoExternalCanonicalWorkflowOutput(previousState)
  const previouslyOwnedRoutes = new Set(previousOwnership?.routes ?? [])
  const preservedRoutes = (previousState?.routes ?? []).filter(route => JSON.stringify(route).includes("/.well-known/workflow/v1/") && !previouslyOwnedRoutes.has(JSON.stringify(route)))
  const currentRoutes = (Array.isArray(viteHubConfig.routes) ? viteHubConfig.routes : []).filter(route => !previouslyOwnedRoutes.has(JSON.stringify(route)))
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
  // The native builder has no esbuild define option. Transform both intermediate
  // bundles before it embeds the VM code and combines the step registrations.
  class ConfiguredWorkflowBuilder extends builders.VercelBuildOutputAPIBuilder {
    protected override async createStepsBundle(options: { inputFiles: string[], outfile: string }) {
      const result = await super.createStepsBundle(options)
      if (!Object.keys(bundleDefines).length) return result
      const source = await readFile(options.outfile, "utf8")
      const output = await transform(source, { define: bundleDefines, sourcefile: options.outfile, sourcemap: "inline" })
      await writeFile(options.outfile, output.code)
      return result
    }

    protected override async createWorkflowsBundle(options: { inputFiles: string[], outfile: string }) {
      const result = await super.createWorkflowsBundle(options)
      if (result.interimBundleText && Object.keys(bundleDefines).length) {
        const output = await transform(result.interimBundleText, { define: bundleDefines, sourcefile: options.outfile, sourcemap: "inline" })
        result.interimBundleText = output.code
      }
      return result
    }
  }
  const builder = new ConfiguredWorkflowBuilder({
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
    const workflowConfig = parseJsonRecord(await readFile(outputConfigFile, "utf8"), "Workflow Vercel output config")
    const workflowRoutes = Array.isArray(workflowConfig.routes) ? workflowConfig.routes : []
    await writeFile(outputConfigFile, `${JSON.stringify({
      ...workflowConfig,
      ...viteHubConfig,
      routes: [...workflowRoutes, ...viteHubRoutes],
    }, null, 2)}\n`, "utf8")
    const generatedFiles = await collectVercelNativeWorkflowFiles(workflowRoot)
    const ownedFiles = Object.fromEntries(Object.entries(generatedFiles)
      .filter(([file, digest]) => previousFiles[file] !== digest || previousFiles[file] === previousOwnership?.files[file]))
    const routeTargetsOwnedFunction = (route: unknown) => {
      if (!route || typeof route !== "object") return false
      return ["dest", "src"]
        // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
        .map(key => (route as Record<string, unknown>)[key])
        .filter((value): value is string => typeof value === "string")
        .some((target) => {
          const functionPath = target.match(/\/\.well-known\/workflow\/(v1\/[^?]+)/)?.[1]
          return Boolean(functionPath && Object.keys(ownedFiles).some(file => file.startsWith(`${functionPath}.func/`)))
        })
    }
    const ownership: VercelNativeWorkflowOwnership = {
      files: ownedFiles,
      routes: [...new Map([...workflowRoutes, ...preservedRoutes].map(route => [JSON.stringify(route), route])).values()]
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

function resolveWorkflowUserAppEntry(rootDir: string, entry: true | string) {
  return resolveUserAppEntry(rootDir, entry === true ? {} : { names: [entry] })
}

interface ProviderEntrySpec {
  name: WorkflowProvider
  entryFile: string
  runtimeModule: WorkflowRuntimeModuleName
  factory: string
  hosting: string
}

const providerEntrySpecs: ProviderEntrySpec[] = [
  { name: "cloudflare", entryFile: "cloudflare-worker.mjs", runtimeModule: "cloudflare-vite", factory: "createWorkflowCloudflareWorker", hosting: "cloudflare" },
  { name: "vercel", entryFile: "vercel-server.mjs", runtimeModule: "vercel-vite", factory: "createWorkflowVercelServer", hosting: "vercel" },
]

function resolveWorkflowConfig(workflow: WorkflowOptions | undefined, hosting: string, inline = false): false | ResolvedWorkflowOptions {
  return normalizeWorkflowOptions(workflow, { hosting, inline }) ?? false
}

/**
 * The Provider Output that a build writes. Without a host, both outputs are written.
 * Only Vercel deploys the Vercel output, so other hosts skip it. `inline` lets a host without an inferable provider
 * run Workflows inline instead of failing, as in `vite dev` and for the Workflow that only the Agent turns on.
 */
export function resolveWorkflowProviderOutputs(workflow: WorkflowOptions | undefined, hosting?: string, inline = false): {
  cloudflare: false | ResolvedWorkflowOptions
  vercel: false | ResolvedWorkflowOptions
} {
  if (!hosting) {
    return { cloudflare: resolveWorkflowConfig(workflow, "cloudflare"), vercel: resolveWorkflowConfig(workflow, "vercel") }
  }
  const config = resolveWorkflowConfig(workflow, hosting, inline)
  return {
    cloudflare: config && config.provider === "cloudflare" ? config : false,
    vercel: config && config.provider === "vercel" && getHostingProvider(hosting) === "vercel" ? config : false,
  }
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
  artifacts?: GeneratedWorkflowArtifacts
  agentModules?: AgentWorkflowModules
  clientOutDir: string
  bundleDefines?: Record<string, string>
  hosting?: string
  importBase?: string
  /** Run Workflows inline when the host has no inferable provider. See `resolveWorkflowProviderOutputs()`. */
  inline?: boolean
  providerImportAliases?: Record<string, string>
  providerRuntimeImportAliases?: Partial<Record<WorkflowProvider, Record<string, string>>>
  vercelRuntimePackages?: VercelFunctionRuntimePackage[]
  definitionRootDir?: string
  rootDir: string
  serverDirs?: string[]
  serverFunctionName?: string
  /**
   * Nitro's server function runs the routes on Vercel, and its startup plugin installs the Workflow registry. So no
   * Workflow server function is written. The native Workflow functions are still written.
   */
  nitroServer?: boolean
  sourceRootDir?: string
  includeUserAppEntry?: boolean | string
  workflow: WorkflowOptions | undefined
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
  workspaceRuntimeModule?: string
  transformRegistry?: (code: string, id: string) => string | Promise<string>
  /** Nitro's Worker holds the Cloudflare Workflows, so no separate Cloudflare Workflow Worker is written. */
  cloudflareInNitro?: boolean
}

interface WorkspaceDependencyRuntimeImports {
  sandboxTask?: string
  sandboxTaskRuntimeState?: string
  shellWorkspace?: string
}

/** The Agent files that a generated Workflow registry imports, by path. `agentRuntimeModule()` in `@vite-hub/agent/vite` gives them. */
export interface AgentWorkflowModules {
  index: string
  runtimeWorkflow: string
  serverInternal: string
}

interface WorkflowImportBases {
  agent?: AgentWorkflowModules
  workflow?: string
  /** The Workspace runtime module, when the app has Workspace dependencies such as Sandbox Tasks. */
  workspaceRuntime?: string
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
  agentModules?: AgentWorkflowModules
  nitro: Record<string, unknown>
  rootDir: string
  serverDirs?: string[]
  includeUserAppEntry?: boolean | string
  workflow: WorkflowOptions | undefined
  workflowImportBase?: string
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
  workspaceRuntimeModule?: string
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

function record(value: unknown): Record<string, unknown> {
  // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
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

function getUniqueLegacyCloudflareWorkflowAliases(definitions: DiscoveredWorkflowDefinition[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const definition of definitions) {
    const alias = getLegacyCloudflareWorkflowClassName(definition.name)
    counts.set(alias, (counts.get(alias) || 0) + 1)
  }
  const aliases = new Map<string, string>()
  for (const definition of definitions) {
    const alias = getLegacyCloudflareWorkflowClassName(definition.name)
    if (counts.get(alias) === 1) aliases.set(definition.name, alias)
  }
  return aliases
}

function renderCloudflareWorkflowEntrypoint(
  definition: DiscoveredWorkflowDefinition,
  legacyAliases: ReadonlyMap<string, string>,
): string {
  const className = getCloudflareWorkflowClassName(definition.name)
  const legacyClassName = legacyAliases.get(definition.name)
  return [
    `export class ${className} extends WorkflowEntrypoint {`,
    "  async run(event, step) {",
    `    return await runViteHubWorkflowDefinition(${JSON.stringify(definition.name)}, this.env || {}, event, step)`,
    "  }",
    "}",
    ...(legacyClassName ? [`export { ${className} as ${legacyClassName} }`] : []),
    "",
  ].join("\n")
}

function createCloudflareWorkflowNitroPlugin(entryFile: string, definitions: DiscoveredWorkflowDefinition[]): VitePlugin {
  const moduleId = "virtual:vitehub-workflow-cloudflare-exports"
  const legacyAliases = getUniqueLegacyCloudflareWorkflowAliases(definitions)
  const resolvedModuleId = `\0${moduleId}`
  const fileName = "workflow-cloudflare-exports.mjs"
  return {
    name: "vitehub-workflow-cloudflare-exports",
    buildStart() {
      this.emitFile({ fileName, id: moduleId, type: "chunk" })
    },
    resolveId: {
      filter: { id: /^(?:virtual:vitehub-workflow-cloudflare-exports$|file:)/ },
      handler(id: string) {
        if (id === moduleId) return resolvedModuleId
        if (id.startsWith("file:")) return fileURLToPath(id)
      },
    },
    load: {
      filter: { id: /^\0virtual:vitehub-workflow-cloudflare-exports$/ },
      handler(id: string) {
        if (id !== resolvedModuleId) return
        return [
          `import { WorkflowEntrypoint } from "cloudflare:workers"`,
          `import { installViteHubWorkflowRuntime, runViteHubWorkflowDefinition } from ${JSON.stringify(entryFile)}`,
          "",
          "installViteHubWorkflowRuntime()",
          "",
          ...definitions.map(definition => renderCloudflareWorkflowEntrypoint(definition, legacyAliases)),
        ].join("\n")
      },
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry || (chunk.fileName !== "index.mjs" && chunk.fileName !== "index.js")) return null
      const classes = definitions.flatMap(definition => [
        getCloudflareWorkflowClassName(definition.name),
        ...(legacyAliases.get(definition.name) ? [legacyAliases.get(definition.name)!] : []),
      ]).join(", ")
      return { code: `${code}\nexport { ${classes} } from './${fileName}'\n`, map: null }
    },
  }
}

export async function createCloudflareWorkflowNitroConfig(options: CloudflareWorkflowNitroOptions): Promise<Record<string, unknown>> {
  const preset = String(options.nitro.preset || "")
  if (options.workflow === undefined && !preset.includes("cloudflare")) return options.nitro
  // Only a Cloudflare result matters here. Other hosts report a missing provider in the Workflow build.
  const config = normalizeWorkflowOptions(options.workflow, { hosting: preset, inline: true })
  if (!config || config.provider !== "cloudflare") return options.nitro

  const artifacts = await writeProviderEntries(options.rootDir, options.workflow, {
    agent: options.agentModules,
    workflow: options.workflowImportBase,
    workspaceRuntime: options.workspaceRuntimeModule,
    workspaceDependencies: options.workspaceDependencyRuntimeImports,
  }, options.serverDirs, options.includeUserAppEntry, options.transformRegistry)
  if (!artifacts.providerDefinitions.length) return options.nitro

  const nitro = { ...options.nitro }
  const middlewareFile = resolve(ensureGeneratedDir(options.rootDir, productName), "nitro-middleware.ts")
  await writeFile(middlewareFile, [
    'import { defineMiddleware } from "nitro"',
    'import { env, waitUntil } from "cloudflare:workers"',
    `import { enterWorkflowRuntimeEvent } from ${JSON.stringify(workflowRuntimeModule("state"))}`,
    '',
    'export default defineMiddleware((event) => {',
    '  Object.assign(event, { env, waitUntil })',
    '  enterWorkflowRuntimeEvent(event)',
    '})',
    '',
  ].join("\n"), "utf8")
  const handlers = Array.isArray(nitro.handlers) ? [...nitro.handlers] : []
  if (!handlers.some(handler => record(handler).handler === middlewareFile)) {
    handlers.unshift({ handler: middlewareFile, middleware: true, route: "/**" })
  }
  nitro.handlers = handlers
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
  return `import(${JSON.stringify(pathToFileURL(file).href)})`
}

function resolveAgentWorkspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
}

function readAgentInstructions(file: string, dependencies?: Set<string>): string | undefined {
  const instructions = join(dirname(file), "instructions.md")
  if (!existsSync(instructions) || !statSync(instructions).isFile()) return
  dependencies?.add(instructions)
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
  retainedAgentInstructions?: ReadonlyMap<string, string | undefined>,
) {
  const instructions = retainedAgentInstructions?.has(definition.handler)
    ? retainedAgentInstructions.get(definition.handler)
    : readAgentInstructions(definition.handler)
  return [
    `  [${JSON.stringify(definition.name)}]: Object.assign(async () => {`,
    `    const cached = registryEntryCache.get(${JSON.stringify(definition.name)})`,
    "    if (cached) return cached",
    `    const loaded = await ${renderRegistryImport(registryFile, definition.handler)}`,
    `    const agent = workspaceAgentWithSourceRoot(agentWithColocatedSkills(agentWithColocatedInstructions("default" in loaded ? loaded.default : loaded, ${JSON.stringify(instructions)}), ${JSON.stringify(readAgentSkills(definition.handler))}), ${JSON.stringify(resolveAgentWorkspaceSourceRoot(definition.handler))}, ${JSON.stringify(instructions)})`,
    `    const entry = { options: { rootStep: false }, handler: async (_payload, context) => await runAgentWorkflowDefinition(agent, { ...context, payload: { ...context.payload, agentIdentity: context.payload?.agentIdentity || { name: ${JSON.stringify(definition.agentIdentity || definition.name)} } } }, runAgentInline)${definition.source === "agent-workflow-recovery" ? ", internalAgentInvocationRecovery: true" : ""} }`,
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
  retainedAgentInstructions?: ReadonlyMap<string, string | undefined>,
) {
  if (definition.source === "agent-workflow" || definition.source === "agent-workflow-recovery") {
    return renderAgentWorkflowRegistryEntry(registryFile, definition, retainedAgentInstructions)
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
    : "{ handler: async (payload, context) => { let value = payload; for (const step of Object.values(context.steps)) value = await step(value); return value } }"

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
    "      handler: async (payload, context) => {",
    "        const workflowSteps = createWorkflowSteps(context, steps)",
    "        return await definition.handler(payload, { ...context, steps: workflowSteps })",
    "      },",
    "    }",
    `    registryEntryCache.set(${JSON.stringify(definition.name)}, entry)`,
    "    return entry",
    "  },",
  ].filter(Boolean).join("\n")
}

/** Without `hubAgent()`, Agent Workflows load the Agent package that the app installs, by the paths it hands out. */
async function installedAgentWorkflowModules(rootDir: string): Promise<AgentWorkflowModules | undefined> {
  let agentVite: string
  try {
    agentVite = createRequire(resolve(rootDir, "package.json")).resolve("@vite-hub/agent/vite")
  }
  catch {
    return undefined
  }
  // SAFETY: Workflow does not depend on the Agent package, so its types are not available here.
  const { agentRuntimeModule } = await import(pathToFileURL(agentVite).href) as { agentRuntimeModule: (entry: string) => string }
  return {
    index: agentRuntimeModule("index"),
    runtimeWorkflow: agentRuntimeModule("runtime/workflow"),
    serverInternal: agentRuntimeModule("server/internal"),
  }
}

export function createWorkflowRegistryContents(
  registryFile: string,
  definitions: DiscoveredWorkflowDefinition[],
  importBases: WorkflowImportBases = {},
  vercelNativeFiles: Record<string, string> = {},
  retainedAgentInstructions?: ReadonlyMap<string, string | undefined>,
): string {
  const needsWorkflowRuntime = definitions.some(definition => definition.steps?.length)
  const needsAgentRuntime = definitions.some(definition => definition.source === "agent-workflow" || definition.source === "agent-workflow-recovery")
  const needsRegistryEntryCache = needsWorkflowRuntime || needsAgentRuntime
  const installAgentWorkflowRuntime = needsAgentRuntime && importBases.workflow
  const workspaceDependencyRuntimeImports = importBases.workspaceRuntime ? importBases.workspaceDependencies : undefined
  const agent = importBases.agent
  if (needsAgentRuntime && !agent) throw workflowErrorDiagnostics.WORKFLOW_B0003()
  const imports = [
    ...(needsAgentRuntime && agent
      ? [
          `import { agentWithColocatedInstructions } from ${JSON.stringify(agent.index)}`,
          `import { agentWithColocatedSkills, runAgentWorkflowDefinition, workspaceAgentWithSourceRoot } from ${JSON.stringify(agent.runtimeWorkflow)}`,
          `import { installAgentChannelDeliveryWorkflowResolver, runAgentInline } from ${JSON.stringify(agent.serverInternal)}`,
          ...(installAgentWorkflowRuntime
            ? [`import { setAgentWorkflowRuntimeLoaders } from ${JSON.stringify(agent.serverInternal)}`]
            : []),
        ]
      : []),
    ...(needsWorkflowRuntime
      ? [
          `import { createWorkflowSteps } from ${JSON.stringify(workflowRuntimeModule("execute"))}`,
          `import { takeInlineWorkflowDefinitionForModule } from ${JSON.stringify(workflowRuntimeModule("state"))}`,
        ]
      : []),
    ...(workspaceDependencyRuntimeImports
      ? [`import { setWorkspaceDependencyRuntimeLoaders } from ${JSON.stringify(importBases.workspaceRuntime)}`]
      : []),
  ]

  return [
    ...imports,
    imports.length ? "" : "",
    ...(needsAgentRuntime ? ["installAgentChannelDeliveryWorkflowResolver()", ""] : []),
    ...(installAgentWorkflowRuntime
      ? [
          "setAgentWorkflowRuntimeLoaders({",
          `  state: () => import(${JSON.stringify(workflowRuntimeModule("state"))}),`,
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
    ...definitions.map(definition => renderWorkflowRegistryEntry(registryFile, definition, vercelNativeFiles, retainedAgentInstructions)),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}

/**
 * Hosts import this index at startup. It holds the Workflow names and metadata, and imports the
 * definition loaders on the first run: Cloudflare Workers export the Workflow classes from the entry.
 */
function createWorkflowRegistryIndexContents(definitions: DiscoveredWorkflowDefinition[]): string {
  return [
    `const loadRegistryRuntime = () => import(${JSON.stringify(`./${generatedRegistryRuntimeFileName}`)})`,
    "",
    "const registry = {",
    ...definitions.map((definition) => {
      const loader = `async () => await (await loadRegistryRuntime()).default[${JSON.stringify(definition.name)}]()`
      return definition.source === "agent-workflow-recovery"
        ? `  [${JSON.stringify(definition.name)}]: Object.assign(${loader}, { internalAgentInvocationRecovery: true }),`
        : `  [${JSON.stringify(definition.name)}]: ${loader},`
    }),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}

function renderCloudflareWorkerWrapper(definitions: DiscoveredWorkflowDefinition[]) {
  const legacyAliases = getUniqueLegacyCloudflareWorkflowAliases(definitions)
  return [
    definitions.length ? `import { WorkflowEntrypoint, waitUntil as viteHubWaitUntil } from "cloudflare:workers"` : `import { waitUntil as viteHubWaitUntil } from "cloudflare:workers"`,
    cloudflareWorkflowWrapperImport,
    "",
    ...definitions.map(definition => renderCloudflareWorkflowEntrypoint(definition, legacyAliases)),
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
  workflowImportBase: string,
  framework: boolean,
) {
  const installVercelWorkflowRuntime = spec.name === "vercel" && framework
  const imports = [
    `import { ${spec.factory}${spec.name === "cloudflare" ? ", installWorkflowCloudflareRuntime" : ""}${installVercelWorkflowRuntime ? ", setVercelWorkflowRuntimeModules" : ""} } from ${JSON.stringify(workflowRuntimeModule(spec.runtimeModule))}`,
    `import workflowRegistry from ${JSON.stringify(`./${generatedRegistryFileName}`)}`,
    ...(installVercelWorkflowRuntime ? [`import * as workflowApi from "workflow/api"`, `import * as workflowRuntime from "workflow/runtime"`] : []),
  ]
  if (spec.name === "cloudflare") {
    imports.push(`import { runCloudflareWorkflow } from ${JSON.stringify(workflowRuntimeModule("cloudflare-runner"))}`)
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
        // A prerender build loads this module in Node.js, which has no `cloudflare:workflows`. Only a run needs it.
        "  const { NonRetryableError } = await import(\"cloudflare:workflows\")",
        "  return await runCloudflareWorkflow({ config: workflowConfig, createNonRetryableError: error => Object.defineProperty(new NonRetryableError(error.message, error.name), \"cause\", { value: error, configurable: true, writable: true }), env: env || {}, event, name, registry: workflowRegistry, step })",
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
  workflow: WorkflowOptions | undefined,
  importBases: WorkflowImportBases = {},
  serverDirs?: string[],
  includeUserAppEntry: boolean | string = true,
  transformRegistry?: (code: string, id: string) => string | Promise<string>,
  definitionRootDir = rootDir,
  generatedDir = ensureGeneratedDir(rootDir, productName),
  retainedAgentInstructions?: ReadonlyMap<string, string | undefined>,
) {
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverWorkflowDefinitions({ rootDir: definitionRootDir, serverDirs })
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
        // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
        source: "agent-workflow-recovery" as const,
      }]
    : [definition])
  const userAppEntry = includeUserAppEntry ? resolveWorkflowUserAppEntry(definitionRootDir, includeUserAppEntry) : undefined
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
    await writeFile(nativeFile, createVercelNativeWorkflowContents(definition), "utf8")
  }))
  const registryRuntimeFile = resolve(generatedDir, generatedRegistryRuntimeFileName)
  const agentModules = importBases.agent ?? (providerDefinitions.some(definition => definition.source === "agent-workflow")
    ? await installedAgentWorkflowModules(rootDir)
    : undefined)
  const registryContents = createWorkflowRegistryContents(
    registryRuntimeFile,
    providerDefinitions,
    { ...importBases, agent: agentModules },
    vercelNativeFiles,
    retainedAgentInstructions,
  )
  await writeFile(registryRuntimeFile, transformRegistry ? await transformRegistry(registryContents, registryRuntimeFile) : registryContents, "utf8")
  await writeFile(registryFile, createWorkflowRegistryIndexContents(providerDefinitions), "utf8")

  const entryFiles: Record<WorkflowProvider, string> = { cloudflare: "", openworkflow: "", vercel: "" }
  await Promise.all(providerEntrySpecs.map(async (spec) => {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const workflowConfig = spec.name === "cloudflare"
      ? cloudflareWorkflowConfig
      : resolveWorkflowConfig(workflow, spec.hosting)
    const serialized = JSON.stringify(workflowConfig, null, 2)
    await writeFile(entryFile, renderProviderEntry(
      spec,
      entryFile,
      userAppEntry,
      serialized,
      importBases.workflow ?? workflowPackageName,
      Boolean(importBases.workflow),
    ), "utf8")
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

export function discoverWorkflowProviderSources(definitionRootDir: string, serverDirs?: string[]): {
  agentInstructions: ReadonlyMap<string, string | undefined>
  paths: string[]
} {
  const agentInstructions = new Map<string, string | undefined>()
  const paths = discoverWorkflowDefinitions({ rootDir: definitionRootDir, serverDirs })
    .flatMap((definition) => {
      const executableSources = [
        ...(statSync(definition.handler).isFile() ? [definition.handler] : []),
        ...(definition.steps ?? []),
      ]
      if (definition.source !== "agent-workflow") return executableSources
      const instructionDependencies = new Set<string>()
      agentInstructions.set(definition.handler, readAgentInstructions(definition.handler, instructionDependencies))
      const workspaceRoot = join(dirname(definition.handler), "workspace")
      return [
        ...executableSources,
        ...instructionDependencies,
        resolveColocatedAgentFilesRoot(definition.handler, "skills"),
        existsSync(workspaceRoot) && statSync(workspaceRoot).isDirectory() ? workspaceRoot : undefined,
      ].filter((path): path is string => Boolean(path))
    })
  return { agentInstructions, paths }
}

export function discoverWorkflowProviderSourcePaths(definitionRootDir: string, serverDirs?: string[]): string[] {
  return discoverWorkflowProviderSources(definitionRootDir, serverDirs).paths
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

async function createCloudflareWorkflowCleanup(rootDir: string, cloudflareInNitro = false) {
  const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
  let ownsWrapper = false
  try {
    ownsWrapper = (await readFile(resolve(outputRoot, "index.js"), "utf8")).includes(cloudflareWorkflowWrapperImport)
  }
  catch (error) {
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return {
    fileNames: ownsWrapper ? ["index.js", "worker.mjs", deployedWorkflowSourcesPath] : ["worker.mjs", deployedWorkflowSourcesPath],
    outputRoot,
    wranglerConfigOwnership: {
      // Nitro has already written the shared config, including its Workflow bindings.
      keys: cloudflareInNitro ? [] : ownsWrapper ? cloudflareWorkflowWranglerConfigKeys : ["workflows"],
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
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
    ...(serverFunctionName ? { function: { kind: "isolated" as const, name: serverFunctionName } } : {}),
  }
}

function isSafeVercelFunctionName(functionsRoot: string, serverFunctionName: string): boolean {
  const path = relative(functionsRoot, resolve(functionsRoot, serverFunctionName))
  return Boolean(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path)
}

async function readVercelWorkflowFunctionOwnership(functionRoot: string): Promise<VercelWorkflowFunctionOwnership | undefined> {
  try {
    const ownership = parseJsonRecord(await readFile(resolve(functionRoot, vercelWorkflowFunctionOwnershipMarker), "utf8"), "Vercel Workflow function ownership")
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

async function getVercelWorkflowFunctionOwnership(functionRoot: string): Promise<VercelWorkflowFunctionOwnership | undefined> {
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
}

async function readVercelWorkflowOutputState(rootDir: string, functionsRoot: string): Promise<VercelWorkflowOutputState | undefined> {
  try {
    const state = parseJsonRecord(await readFile(resolve(rootDir, vercelWorkflowOutputState), "utf8"), "Vercel Workflow output state")
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
    const value: unknown = JSON.parse(await readFile(configFile, "utf8"))
    if (!isRuntimeRecord(value)) return
    config = value
  }
  catch (error) {
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
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
    // SAFETY: Generated Workflow module validation establishes the asserted build record contract.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const removedRootConfigRoutes: string[] = []
  const removedFunctionRoots: string[] = []
  for (const serverFunctionName of candidates) {
    if (serverFunctionName === activeServerFunctionName || !isSafeVercelFunctionName(functionsRoot, serverFunctionName)) continue
    const functionRoot = resolve(functionsRoot, serverFunctionName)
    const ownership = await getVercelWorkflowFunctionOwnership(functionRoot)
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
  let artifacts = options.artifacts ?? await writeProviderEntries(options.rootDir, options.workflow, {
    agent: options.agentModules,
    workflow: options.importBase,
    workspaceRuntime: options.workspaceRuntimeModule,
    workspaceDependencies: options.workspaceDependencyRuntimeImports,
  }, options.serverDirs, options.includeUserAppEntry, options.transformRegistry, options.definitionRootDir)
  const { cloudflare: cloudflareWorkflowConfig, vercel: vercelWorkflowConfig } = resolveWorkflowProviderOutputs(options.workflow, options.hosting, options.inline)
  const vercelWorkflow = Boolean(vercelWorkflowConfig && vercelWorkflowConfig.provider === "vercel")
  const workflowTransformPlugin = vercelWorkflow && !options.nitroServer
    ? await createVercelWorkflowTransformPlugin(options.rootDir)
    : undefined
  let commitGeneratedArtifacts = async (): Promise<void> => {}
  let rollbackGeneratedArtifacts = async (): Promise<void> => {}
  // Native Vercel Workflow and step IDs come from the source path. The retained copy has a new path on every build,
  // so the native build reads the published copy, which the server function also imports.
  let publishedSource = (file: string) => file
  const publishGeneratedArtifacts = async (): Promise<GeneratedWorkflowArtifacts> => {
    const generatedDir = resolve(options.rootDir, ".vitehub", productName)
    if (resolve(artifacts.generatedDir) === generatedDir) return artifacts
    const nextDir = `${generatedDir}.${randomUUID()}.next`
    const previousDir = `${generatedDir}.${randomUUID()}.previous`
    const hadPrevious = existsSync(generatedDir)
    let movedPrevious = false
    const retainedSourcesDir = resolve(artifacts.generatedDir, "..", "sources")
    const publishedSourcesDir = resolve(generatedDir, "sources")
    try {
      await cp(artifacts.generatedDir, nextDir, { recursive: true })
      if (existsSync(retainedSourcesDir)) {
        const nextSourcesDir = resolve(nextDir, "sources")
        await cp(retainedSourcesDir, nextSourcesDir, { recursive: true })
        await rebasePublishedProviderSourceLinks(nextSourcesDir, retainedSourcesDir, publishedSourcesDir)
        const rewriteRetainedSourceImports = async (file: string) => {
          const contents = await readFile(file, "utf8")
          const relativeFile = relative(nextDir, file)
          const rewritten = rewriteRetainedProviderSourcePaths(contents, retainedSourcesDir, publishedSourcesDir, {
            published: resolve(generatedDir, relativeFile),
            retained: resolve(artifacts.generatedDir, relativeFile),
          })
          if (rewritten !== contents) await writeFile(file, rewritten, "utf8")
        }
        await rewriteRetainedSourceImports(resolve(nextDir, generatedRegistryRuntimeFileName))
        await Promise.all(artifacts.vercelNativeFiles.map(file => rewriteRetainedSourceImports(resolve(nextDir, relative(artifacts.generatedDir, file)))))
        await Promise.all(providerEntrySpecs.map(async spec => await rewriteRetainedSourceImports(resolve(nextDir, spec.entryFile))))
      }
      if (hadPrevious) {
        await rename(generatedDir, previousDir)
        movedPrevious = true
      }
      await rename(nextDir, generatedDir)
    }
    catch (error) {
      await rm(nextDir, { force: true, recursive: true })
      if (movedPrevious) {
        try {
          await rm(generatedDir, { force: true, recursive: true })
          await rename(previousDir, generatedDir)
        }
        catch (restoreError) {
          throw new AggregateError([error, restoreError], "Generated Workflow artifact rollback failed")
        }
      }
      throw error
    }
    let publicationSettled = false
    commitGeneratedArtifacts = async () => {
      if (publicationSettled) return
      publicationSettled = true
      await removeProviderOutputArtifactDir(previousDir).catch(() => undefined)
    }
    rollbackGeneratedArtifacts = async () => {
      if (publicationSettled) return
      await rm(generatedDir, { force: true, recursive: true })
      if (hadPrevious) await rename(previousDir, generatedDir)
      publicationSettled = true
    }
    const publishedFile = (file: string) => resolve(generatedDir, relative(artifacts.generatedDir, file))
    publishedSource = (file: string) => {
      const path = relative(retainedSourcesDir, file)
      return path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? resolve(publishedSourcesDir, path) : file
    }
    return {
      ...artifacts,
      cloudflareWorkerFile: publishedFile(artifacts.cloudflareWorkerFile),
      generatedDir,
      registryFile: publishedFile(artifacts.registryFile),
      vercelNativeFiles: artifacts.vercelNativeFiles.map(publishedFile),
      vercelServerFile: publishedFile(artifacts.vercelServerFile),
    }
  }
  artifacts = await publishGeneratedArtifacts()
  const cloudflareOutput = cloudflareWorkflowConfig && cloudflareWorkflowConfig.provider === "cloudflare" && !options.cloudflareInNitro
    ? createCloudflareOutput(options.rootDir, artifacts, {
        ...options.providerImportAliases,
        ...options.providerRuntimeImportAliases?.cloudflare,
      })
    : undefined
  const vercelOutput = vercelWorkflow && !options.nitroServer
    ? createVercelOutput(options.rootDir, artifacts, workflowTransformPlugin, options.importBase, {
        ...options.providerImportAliases,
        ...options.providerRuntimeImportAliases?.vercel,
      }, options.serverFunctionName)
    : undefined
  // The provider output transaction snapshots .vercel/output before this runs and restores it when this throws.
  const writeOutputs = async () => {
    const previousNativeOutput = await readVercelNativeWorkflowState(options.rootDir)
    const nativeDefinitions = artifacts.providerDefinitions.map(definition => ({
      ...definition,
      handler: publishedSource(definition.handler),
      ...(definition.steps ? { steps: definition.steps.map(publishedSource) } : {}),
    }))
    const nativeAliases = Object.fromEntries(Object.entries({
      ...options.providerImportAliases,
      ...options.providerRuntimeImportAliases?.vercel,
    }).map(([alias, target]) => [alias, publishedSource(target)]))
    if (vercelWorkflow && hasVercelNativeWorkflowEntry(options.rootDir, nativeDefinitions, nativeAliases, artifacts.vercelNativeFiles)) {
      assertNoExternalCanonicalWorkflowOutput(previousNativeOutput)
    }
    const deploymentOutput: ProviderDeploymentOutputOptions = {
      clientOutDir: options.clientOutDir,
      cloudflare: cloudflareOutput,
      cleanup: {
        cloudflare: cloudflareOutput ? undefined : () => createCloudflareWorkflowCleanup(options.rootDir, options.cloudflareInNitro),
      },
      afterWrite: async (signal) => {
        signal?.throwIfAborted()
        const publishedSourcesDir = resolve(artifacts.generatedDir, "sources")
        if (cloudflareOutput) {
          await publishProviderSourcesToDeploymentOutputs({
            destinations: [{
              files: [resolve(createDefaultCloudflareOutputRoot(options.rootDir), "worker.mjs")],
              runtimeSourcesDir: `./${deployedWorkflowSourcesPath}`,
              sourcesDir: resolve(createDefaultCloudflareOutputRoot(options.rootDir), deployedWorkflowSourcesPath),
            }],
            publishedSourcesDir,
            signal,
          })
        }
        if (vercelOutput) {
          const functionRoot = resolve(createDefaultVercelOutputRoot(options.rootDir), "functions", options.serverFunctionName ?? "__server.func")
          await publishProviderSourcesToDeploymentOutputs({
            destinations: [{
              files: [resolve(functionRoot, "index.mjs")],
              runtimeSourcesDir: `./${deployedWorkflowSourcesPath}`,
              sourcesDir: resolve(functionRoot, deployedWorkflowSourcesPath),
            }],
            publishedSourcesDir,
            signal,
          })
        }
        if (vercelWorkflow) {
          await buildVercelNativeWorkflowOutput(options.rootDir, nativeDefinitions, nativeAliases, artifacts.vercelNativeFiles, previousNativeOutput, options.bundleDefines)
        }
        else {
          await cleanVercelNativeWorkflowOutput(options.rootDir)
        }
        signal?.throwIfAborted()
        await updateVercelWorkflowFunctionOwnership(options.rootDir, vercelOutput ? options.serverFunctionName ?? "__server.func" : undefined, Boolean(vercelOutput && !options.serverFunctionName))
        signal?.throwIfAborted()
      },
      rootDir: options.rootDir,
      sourceRootDir: options.sourceRootDir,
    }
    if (vercelOutput) deploymentOutput.vercel = vercelOutput
    await writeProviderDeploymentOutputs(deploymentOutput)
    if (vercelOutput) {
      await copyVercelFunctionRuntimePackages({
        packages: options.vercelRuntimePackages ?? [],
        rootDir: options.rootDir,
        serverFunctionName: options.serverFunctionName ?? "__server.func",
      })
    }
  }
  try {
    if (workflowTransformPlugin && options.importBase) await withVercelWorkflowPackageLink(options.rootDir, writeOutputs)
    else await writeOutputs()
    await commitGeneratedArtifacts()
  }
  catch (error) {
    try {
      await rollbackGeneratedArtifacts()
    }
    catch (restoreError) {
      throw new AggregateError([error, restoreError], "Generated Workflow artifact rollback failed")
    }
    throw error
  }
  return artifacts
}

export async function generateWorkflowProviderOutputs(
  options: GenerateProviderOutputsOptions,
  write?: ProviderDeploymentOutputWriter,
): Promise<GeneratedWorkflowArtifacts> {
  if (write) return await generateProviderOutputsWithinLock(options, write)
  return await withProviderDeploymentOutputLock(options.rootDir, async lockedWrite => await generateProviderOutputsWithinLock(options, lockedWrite))
}
