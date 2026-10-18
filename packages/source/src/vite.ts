import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  resolveViteHubProjectRoot,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_PROJECT_ROOT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { findExportNames } from "mlly"

import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin } from "vite"
import { inspectCollectionDefinitions } from "./inspect.ts"
import { collectCollectionFiles, discoverCollections } from "./internal/collection-discovery.ts"
import { collectionRoutePath } from "./internal/collection-route.ts"
import { sourceErrorDiagnostics } from "./error-diagnostics.ts"

import type { DiscoveredCollection } from "./internal/collection-discovery.ts"

export { inspectCollectionDefinitions, type CollectionInspectionOptions } from "./inspect.ts"

const collectionTypesEntry = ".vitehub/types/source/collections.d.ts"
const collectionTypesPackageEntry = ".vitehub/types/source/vitehub-source-registry.d.ts"
const collectionRoutesDirectory = ".vitehub/source/routes"
const contentRouteEntry = ".vitehub/content/route.mjs"
const contentPreviewEntry = ".vitehub/content/preview.mjs"
// Auth owns this virtual module. Generated routes import it only when Auth is enabled.
const authServerModuleId = "#vitehub/auth/server"
const initialHostRefreshRetryDelay = 25
const maximumHostRefreshRetryDelay = 1_000
const hostRestartOwnerSettlementTimeout = 30_000

/** A file ViteHub generates for Nitro: a route handler, or a Nitro plugin such as the Content preview scope. */
export type GeneratedSourceHandler = GeneratedSourceRoute | GeneratedSourcePlugin

export interface GeneratedSourceRoute {
  handler: string
  method?: "get"
  plugin?: never
  route: string
}

/** A generated Nitro plugin. It registers no route, so it never conflicts with one. */
export interface GeneratedSourcePlugin {
  handler: string
  method?: never
  plugin: true
  route?: never
}

export interface SourceGenerationOptions {
  /** Pass Auth's `withAuthorization` to generated Collection routes. Requires the Auth Vite plugin. */
  auth?: boolean
  contentImportBase?: string
  importBase?: string
  projectRoot: string
  serverDirs?: string[]
}

export interface SourceVitePluginOptions {
  /** Pass Auth's `withAuthorization` to generated Collection routes when the Auth Vite plugin has a Definition. */
  auth?: boolean | ((input: { configuredAuth?: boolean, projectRoot: string, serverDirs?: string[] }) => boolean)
  contentImportBase?: string
  importBase?: string
}

export type GeneratedSourceHandlersListener = (handlers: GeneratedSourceHandler[]) => Promise<void> | void

export interface GeneratedSourceHandlersListenerOptions {
  handlesHostRestart?: boolean
  projectRoot?: string
}

interface NitroGeneratedConfig {
  handlers?: Array<{ handler: string, method?: string, middleware?: boolean, route?: string }>
  modules?: unknown[]
  plugins?: unknown[]
}

interface SourceNitroHost extends NitroRouteGuard {
  options: NitroGeneratedConfig
  routing: { sync(): void }
}

interface NitroRouteGuard {
  hooks: { hook(name: "build:before", callback: () => void): void }
  scannedHandlers: Array<{ method?: string, middleware?: boolean, route?: string }>
}

interface SourcePluginConfig {
  auth?: false | Record<string, never>
  base?: string
  define?: Record<string, string>
  nitro?: unknown
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_PROJECT_ROOT]?: string
  [VITEHUB_SERVER_DIRS]?: string[]
}

interface GeneratedSourceArtifactsSnapshot {
  files: Map<string, string>
}

async function snapshotDirectoryFiles(directory: string, files: Map<string, string>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await snapshotDirectoryFiles(path, files)
    else if (entry.isFile()) files.set(path, await readFile(path, "utf8"))
  }
}

async function snapshotGeneratedSourceArtifacts(projectRoot: string): Promise<GeneratedSourceArtifactsSnapshot> {
  const files = new Map<string, string>()
  const fixedEntries = [
    collectionTypesEntry,
    collectionTypesPackageEntry,
    contentRouteEntry,
    contentPreviewEntry,
  ]
  for (const entry of fixedEntries) {
    const path = resolve(projectRoot, entry)
    try {
      files.set(path, await readFile(path, "utf8"))
    }
    catch (error) {
      if (!(error instanceof Error && Reflect.get(error, "code") === "ENOENT")) throw error
    }
  }
  const routesDirectory = resolve(projectRoot, collectionRoutesDirectory)
  try {
    await snapshotDirectoryFiles(routesDirectory, files)
  }
  catch (error) {
    if (!(error instanceof Error && Reflect.get(error, "code") === "ENOENT")) throw error
  }
  return { files }
}

async function restoreGeneratedSourceArtifacts(
  projectRoot: string,
  snapshot: GeneratedSourceArtifactsSnapshot,
): Promise<void> {
  const routesDirectory = resolve(projectRoot, collectionRoutesDirectory)
  await rm(routesDirectory, { force: true, recursive: true })
  for (const entry of [
    collectionTypesEntry,
    collectionTypesPackageEntry,
    contentRouteEntry,
    contentPreviewEntry,
  ]) {
    const path = resolve(projectRoot, entry)
    if (!snapshot.files.has(path)) await rm(path, { force: true })
  }
  for (const [path, contents] of snapshot.files) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
}

function methodsOverlap(left: string | undefined, right: string | undefined): boolean {
  return !left || !right || left.toLowerCase() === right.toLowerCase()
}

function generatedRouteOwner(handler: GeneratedSourceRoute): "Collection" | "Content" {
  return handler.route === "/api/content/**" ? "Content" : "Collection"
}

function generatedRouteDescription(handler: GeneratedSourceRoute): string {
  return handler.method ? `${handler.method.toUpperCase()} handler` : "handler"
}

function assertGeneratedRoutes(nitro: NitroRouteGuard, generatedHandlers: GeneratedSourceHandler[]): void {
  for (const generatedHandler of generatedHandlers) {
    if (generatedHandler.plugin) continue
    const duplicate = nitro.scannedHandlers.some(candidate =>
      !candidate.middleware
      && candidate.route === generatedHandler.route
      && methodsOverlap(candidate.method, generatedHandler.method))
    if (duplicate) {
      throw sourceErrorDiagnostics.SOURCE_B0001({ message: `[vitehub] Generated ${generatedRouteOwner(generatedHandler)} route ${JSON.stringify(generatedHandler.route)} conflicts with an existing ${generatedRouteDescription(generatedHandler)}. Remove the matching server route.` })
    }
  }
}

function generatedRouteGuard(generatedHandlers: GeneratedSourceHandler[]) {
  return {
    name: "vite-hub/generated-route-guard",
    setup(nitro: NitroRouteGuard) {
      nitro.hooks.hook("build:before", () => assertGeneratedRoutes(nitro, generatedHandlers))
    },
  }
}

export function mergeGeneratedSourceNitroConfig(
  value: unknown,
  generatedHandlers: GeneratedSourceHandler[],
): NitroGeneratedConfig {
  const nitro: NitroGeneratedConfig = {}
  if (Object(value) === value && !Array.isArray(value)) Object.assign(nitro, value)
  if (generatedHandlers.length === 0) return nitro
  const kit = createNitroServerKit(nitro)
  // SAFETY: The kit materializes Nitro handler entries as the generated route shape, plus Nitro's middleware flag.
  const handlers = kit.config.handlers as Array<GeneratedSourceRoute & { middleware?: boolean }>

  for (const handler of generatedHandlers) {
    if (handler.plugin) {
      kit.addPlugin(handler.handler)
      continue
    }
    const exact = handlers.some(candidate =>
      candidate.handler === handler.handler
      && candidate.route === handler.route
      && candidate.method?.toLowerCase() === handler.method?.toLowerCase())
    if (exact) continue
    const duplicate = handlers.some(candidate =>
      !candidate.middleware && candidate.route === handler.route && methodsOverlap(candidate.method, handler.method))
    if (duplicate) {
      throw sourceErrorDiagnostics.SOURCE_B0002({ message: `[vitehub] Generated ${generatedRouteOwner(handler)} route ${JSON.stringify(handler.route)} conflicts with an existing ${generatedRouteDescription(handler)}. Remove the matching server route.` })
    }
    kit.addHandler(handler)
  }

  const modules = Array.isArray(nitro.modules) ? [...nitro.modules] : []
  if (!modules.some(module =>
    Object(module) === module && Reflect.get(Object(module), "name") === "vite-hub/generated-route-guard")) {
    modules.push(generatedRouteGuard(generatedHandlers))
  }
  kit.config.modules = modules
  // SAFETY: The kit preserves the Nitro config object shape while adding generated route modules.
  return kit.config as NitroGeneratedConfig
}

export function toRuntimeModuleSpecifier(file: string): string {
  return pathToFileURL(file, { windows: /^[A-Z]:[\\/]/i.test(file) }).href
}

export function toTypeModuleSpecifier(file: string): string {
  return file.replaceAll("\\", "/")
}

async function writeFileIfChanged(path: string, contents: string): Promise<void> {
  let current: string | undefined
  try {
    current = await readFile(path, "utf8")
  }
  catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error
  }
  if (current === contents) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

async function writeCollectionArtifacts(
  options: SourceGenerationOptions,
  collections: DiscoveredCollection[],
): Promise<GeneratedSourceHandler[]> {
  const output = resolve(options.projectRoot, collectionTypesEntry)
  const packageOutput = resolve(options.projectRoot, collectionTypesPackageEntry)
  const routesDirectory = resolve(options.projectRoot, collectionRoutesDirectory)
  if (collections.length === 0) {
    await Promise.all([
      rm(output, { force: true }),
      rm(packageOutput, { force: true }),
      rm(routesDirectory, { force: true, recursive: true }),
    ])
    return []
  }

  await writeFileIfChanged(output, [
    "declare global {",
    "  interface ViteHubCollectionMap {",
    ...collections.map(({ exportName, file, name }) =>
      `    ${JSON.stringify(name)}: typeof import(${JSON.stringify(toTypeModuleSpecifier(file))})[${JSON.stringify(exportName)}]`),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n"))
  await writeFileIfChanged(packageOutput, '/// <reference path="./collections.d.ts" />\n')

  const routedCollections = collections.filter(collection => collection.route)
  const expectedRoutes = new Set(routedCollections.map(({ name }) => resolve(routesDirectory, `${name}.mjs`)))
  const existingRoutes = await collectCollectionFiles(routesDirectory)
  await Promise.all(existingRoutes.filter(file => !expectedRoutes.has(file)).map(file => rm(file, { force: true })))
  return await Promise.all(routedCollections.map(async ({ exportName, file, name }) => {
    const handler = resolve(routesDirectory, `${name}.mjs`)
    await writeFileIfChanged(handler, [
      `import { defineCollectionHandler } from ${JSON.stringify(`${options.importBase ?? "@vite-hub/source"}/server`)}`,
      ...(options.auth ? [`import { withAuthorization } from ${JSON.stringify(authServerModuleId)}`] : []),
      `import { ${exportName} as collection } from ${JSON.stringify(toRuntimeModuleSpecifier(file))}`,
      "",
      options.auth
        ? "export default defineCollectionHandler(collection, { withAuthorization })"
        : "export default defineCollectionHandler(collection)",
      "",
    ].join("\n"))
    return {
      handler,
      method: "get" as const,
      route: collectionRoutePath(name),
    }
  }))
}

async function discoverContent(options: SourceGenerationOptions): Promise<string | undefined> {
  const serverDirs = options.serverDirs === undefined
    ? [resolve(options.projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  const candidates: string[] = []
  for (const serverDir of serverDirs) {
    let entries
    try {
      entries = await readdir(serverDir, { withFileTypes: true })
    }
    catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue
      throw error
    }
    candidates.push(...entries
      .filter(entry => entry.isFile() && /^content\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name))
      .map(entry => join(serverDir, entry.name)))
  }
  candidates.sort()
  if (candidates.length > 1) throw sourceErrorDiagnostics.SOURCE_B0007({ message: "[vitehub] Content is defined in more than one server directory." })
  const file = candidates[0]
  if (!file) return
  if (!findExportNames(await readFile(file, "utf8")).includes("content")) {
    throw sourceErrorDiagnostics.SOURCE_B0008({ message: `[vitehub] Content file ${JSON.stringify(relative(options.projectRoot, file))} must export a Comark Content instance named "content".` })
  }
  return file
}

async function writeContentArtifact(
  options: SourceGenerationOptions,
  file: string | undefined,
): Promise<GeneratedSourceHandler[]> {
  const output = resolve(options.projectRoot, contentRouteEntry)
  const preview = resolve(options.projectRoot, contentPreviewEntry)
  if (!file) {
    await Promise.all([rm(output, { force: true }), rm(preview, { force: true })])
    return []
  }
  const importBase = JSON.stringify(options.contentImportBase ?? "@vite-hub/content")
  const contentModule = JSON.stringify(toRuntimeModuleSpecifier(file))
  await writeFileIfChanged(output, [
    `import { defineContentHandler } from ${importBase}`,
    `import { content } from ${contentModule}`,
    "",
    "export default defineContentHandler(content)",
    "",
  ].join("\n"))
  // A Nitro plugin: scopes each request that carries the Content preview cookie to drafts and out of Nitro's cache.
  await writeFileIfChanged(preview, [
    `import { defineContentPreviewPlugin } from ${importBase}`,
    `import { content } from ${contentModule}`,
    "",
    "export default defineContentPreviewPlugin(content)",
    "",
  ].join("\n"))
  return [{ handler: preview, plugin: true }, { handler: output, route: "/api/content/**" }]
}

export async function prepareSourceGeneration(options: SourceGenerationOptions): Promise<GeneratedSourceHandler[]> {
  const [collections, content] = await Promise.all([
    discoverCollections(options),
    discoverContent(options),
  ])
  return [
    ...await writeCollectionArtifacts(options, collections),
    ...await writeContentArtifact(options, content),
  // Plugins have no route and sort first.
  ].sort((left, right) => (left.route ?? "").localeCompare(right.route ?? ""))
}

function applicationBaseURL(base: string | undefined): string {
  return base?.startsWith("/") && !base.startsWith("//") ? base : "/"
}

async function generatedHandlerKey(handlers: GeneratedSourceHandler[]): Promise<string> {
  return JSON.stringify(await Promise.all(handlers.map(async handler => ({
    ...handler,
    contents: await readFile(handler.handler, "utf8"),
  }))))
}

function generatedSourceNitroContribution(
  value: unknown,
  generatedHandlers: GeneratedSourceHandler[],
): NitroGeneratedConfig | undefined {
  let existing: NitroGeneratedConfig = {}
  if (Object(value) === value && !Array.isArray(value)) {
    // SAFETY: the runtime guard excludes primitives and arrays before treating the config as a Nitro config record.
    existing = value as NitroGeneratedConfig
  }
  const merged = mergeGeneratedSourceNitroConfig(existing, generatedHandlers)
  const handlers = merged.handlers?.slice(Array.isArray(existing.handlers) ? existing.handlers.length : 0)
  const modules = merged.modules?.slice(Array.isArray(existing.modules) ? existing.modules.length : 0)
  const plugins = merged.plugins?.slice(Array.isArray(existing.plugins) ? existing.plugins.length : 0)
  if (!handlers?.length && !modules?.length && !plugins?.length) return
  const contribution: NitroGeneratedConfig = {}
  if (handlers?.length) contribution.handlers = handlers
  if (modules?.length) contribution.modules = modules
  if (plugins?.length) contribution.plugins = plugins
  return contribution
}

function sourceDefinitionPath(file: string, projectRoot: string, serverDirs: string[] | undefined): boolean {
  const projectRelativePath = relative(resolve(projectRoot), resolve(file)).replaceAll("\\", "/")
  if (/^server\.auth\.(?:[cm]?[jt]s)$/.test(projectRelativePath)) return true
  const directories = serverDirs === undefined ? [resolve(projectRoot, "server")] : serverDirs
  return directories.some((directory) => {
    const path = relative(resolve(projectRoot, directory), resolve(file)).replaceAll("\\", "/")
    if (path.startsWith("../") || isAbsolute(path)) return false
    return /^content\.(?:[cm]?[jt]s)$/.test(path)
      || /^auth\.(?:[cm]?[jt]s)$/.test(path)
      || (/^collections\/.+\.(?:[cm]?[jt]s)$/.test(path) && !/\.d\.[cm]?ts$/.test(path))
  })
}

export function hubSource(options: SourceVitePluginOptions = {}): Plugin & {
  api: {
    onGeneratedHandlersChanged: (
      listener: GeneratedSourceHandlersListener,
      options?: GeneratedSourceHandlersListenerOptions,
    ) => () => void
    prepareSources: (options: Omit<SourceGenerationOptions, "auth" | "contentImportBase" | "importBase">) => Promise<GeneratedSourceHandler[]>
  }
  nitro: { name: string, setup(nitro: SourceNitroHost): void }
  vitehub: ViteHubInspectionPluginMetadata
} {
  const refreshAuthByRoot = new Map<string, () => unknown>()
  let nitroHost: SourceNitroHost | undefined
  let nitroHostContribution: NitroGeneratedConfig | undefined
  const nitroHandlers: GeneratedSourceHandler[] = []
  let latestProjectRoot: string | undefined
  const configuredStateByRoot = new Map<string, {
    configuredAuth?: boolean
    handlerKey: string
    nitroContribution?: NitroGeneratedConfig
    serverDirs?: string[]
  }>()
  const closeHostRefreshByEnvironment = new WeakMap<object, () => void>()
  const hostRefreshLifecycleByRoot = new Map<string, {
    close: () => void
    pause: () => void
    resume: () => void
  }>()
  const sourcePreparationByRoot = new Map<string, Promise<unknown>>()
  const configurationTransitionByRoot = new Map<string, Promise<unknown>>()
  const generatedHandlersListeners = new Set<{
    handlesHostRestart?: boolean
    listener: GeneratedSourceHandlersListener
    projectRoot?: string
  }>()
  const prepareSources = (
    input: Omit<SourceGenerationOptions, "auth" | "contentImportBase" | "importBase">,
    configuredAuth?: boolean,
  ) => {
    const root = resolve(input.projectRoot)
    const previousPreparation = sourcePreparationByRoot.get(root) ?? Promise.resolve()
    const runPreparation = () => {
      const configuredState = configuredStateByRoot.get(root)
      const resolvedConfiguredAuth = configuredAuth === undefined
        ? configuredState?.configuredAuth
        : configuredAuth
      const auth = typeof options.auth === "function"
        ? options.auth({ configuredAuth: resolvedConfiguredAuth, projectRoot: root, serverDirs: input.serverDirs })
        : options.auth && resolvedConfiguredAuth !== false && Boolean(refreshAuthByRoot.get(root)?.())
      return prepareSourceGeneration({
        ...input,
        auth,
        importBase: options.importBase,
        contentImportBase: options.contentImportBase,
      })
    }
    const preparation = previousPreparation.then(runPreparation, runPreparation)
    sourcePreparationByRoot.set(root, preparation)
    void preparation.finally(() => {
      if (sourcePreparationByRoot.get(root) === preparation) sourcePreparationByRoot.delete(root)
    }).catch(() => {})
    return preparation
  }
  const refresh = async (viteConfig?: SourcePluginConfig) => {
    const projectRoot = viteConfig?.[VITEHUB_PROJECT_ROOT]
      ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
      : viteConfig?.root
        ? resolveViteHubProjectRoot(viteConfig.root)
        : latestProjectRoot
    if (!projectRoot) return
    await prepareSources({
      projectRoot,
      serverDirs: configuredStateByRoot.get(projectRoot)?.serverDirs,
    })
  }
  const onGeneratedHandlersChanged = (
    listener: GeneratedSourceHandlersListener,
    listenerOptions: GeneratedSourceHandlersListenerOptions = {},
  ) => {
    const registration = {
      ...listenerOptions,
      listener,
      projectRoot: listenerOptions.projectRoot
        ? resolve(listenerOptions.projectRoot)
        : latestProjectRoot,
    }
    generatedHandlersListeners.add(registration)
    return () => generatedHandlersListeners.delete(registration)
  }
  const bindUnresolvedListenerRoots = (root: string) => {
    for (const listenerOptions of generatedHandlersListeners.values()) {
      listenerOptions.projectRoot ??= root
    }
  }
  const replaceConfiguredNitroContribution = (
    value: unknown,
    handlers: GeneratedSourceHandler[],
    configuredNitroContribution: NitroGeneratedConfig | undefined,
  ): NitroGeneratedConfig => {
    let nitro: NitroGeneratedConfig = {}
    if (Object(value) === value && !Array.isArray(value)) {
      // SAFETY: the runtime guard excludes primitives and arrays before treating the config as a Nitro config record.
      nitro = { ...(value as NitroGeneratedConfig) }
    }
    const contributedHandlers = configuredNitroContribution?.handlers ?? []
    if (Array.isArray(nitro.handlers) && contributedHandlers.length > 0) {
      nitro.handlers = nitro.handlers.filter(handler => !contributedHandlers.includes(handler))
    }
    const contributedModules = configuredNitroContribution?.modules ?? []
    if (Array.isArray(nitro.modules) && contributedModules.length > 0) {
      nitro.modules = nitro.modules.filter(module => !contributedModules.includes(module))
    }
    const contributedPlugins = configuredNitroContribution?.plugins ?? []
    if (Array.isArray(nitro.plugins) && contributedPlugins.length > 0) {
      nitro.plugins = nitro.plugins.filter(plugin => !contributedPlugins.includes(plugin))
    }
    return mergeGeneratedSourceNitroConfig(nitro, handlers)
  }
  return {
    name: "@vite-hub/source/vite",
    enforce: "post",
    api: { onGeneratedHandlersChanged, prepareSources },
    vitehub: {
      inspect: () => ({
        definitions: [{
          kind: "collection",
          label: "Collections",
          list: () => {
            const projectRoot = latestProjectRoot ?? resolveViteHubProjectRoot(process.cwd())
            return inspectCollectionDefinitions({ projectRoot, serverDirs: configuredStateByRoot.get(projectRoot)?.serverDirs })
          },
        }],
      }),
    },
    nitro: {
      name: "@vite-hub/source/generated-routes",
      setup(nitro) {
        nitroHost = nitro
        nitroHostContribution = undefined
        generatedRouteGuard(nitroHandlers).setup(nitro)
      },
    },
    async config(config) {
      // SAFETY: Vite passes its user config with ViteHub's shared symbols attached.
      const viteConfig = config as SourcePluginConfig
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(viteConfig.root || process.cwd())
      latestProjectRoot = projectRoot
      bindUnresolvedListenerRoots(projectRoot)
      const serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const previousTransition = configurationTransitionByRoot.get(projectRoot) ?? Promise.resolve()
      const runTransition = async () => {
        const previousLifecycle = hostRefreshLifecycleByRoot.get(projectRoot)
        const previousConfiguredState = configuredStateByRoot.get(projectRoot)
        previousLifecycle?.pause()
        try {
          const handlers = await prepareSources({ projectRoot, serverDirs }, viteConfig.auth === false ? false : viteConfig.auth ? true : undefined)
          const handlerKey = await generatedHandlerKey(handlers)
          const nitro = generatedSourceNitroContribution(viteConfig.nitro, handlers)
          configuredStateByRoot.set(projectRoot, {
            configuredAuth: viteConfig.auth === false ? false : viteConfig.auth ? true : undefined,
            handlerKey,
            nitroContribution: nitro,
            serverDirs: serverDirs?.slice(),
          })
          const contribution: SourcePluginConfig = {
            define: { __VITEHUB_APP_BASE_URL__: JSON.stringify(applicationBaseURL(viteConfig.base)) },
            ...(nitro ? { nitro } : {}),
          }
          previousLifecycle?.close()
          return contribution
        }
        catch (error) {
          try {
            if (previousConfiguredState) {
              await prepareSources({
                projectRoot,
                serverDirs: previousConfiguredState.serverDirs,
              })
            }
          }
          finally {
            previousLifecycle?.resume()
          }
          throw error
        }
      }
      const transition = previousTransition.then(runTransition, runTransition)
      configurationTransitionByRoot.set(projectRoot, transition)
      void transition.finally(() => {
        if (configurationTransitionByRoot.get(projectRoot) === transition) {
          configurationTransitionByRoot.delete(projectRoot)
        }
      }).catch(() => {})
      return transition
    },
    async configResolved(config) {
      // SAFETY: Vite's resolved config retains the ViteHub symbols added during the config hook.
      const viteConfig = config as SourcePluginConfig
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root)
      latestProjectRoot = projectRoot
      bindUnresolvedListenerRoots(projectRoot)
      // Auth owns discovery. Refresh it during preparation so watcher listener order cannot leave stale imports.
      const authPlugin = (config.plugins ?? []).flat(Infinity).find(plugin => plugin.name === "@vite-hub/auth/vite")
      const refreshAuth: unknown = Reflect.get(Object(Reflect.get(Object(authPlugin), "api")), "refresh")
      if (refreshAuth instanceof Function) refreshAuthByRoot.set(projectRoot, () => refreshAuth())
      else refreshAuthByRoot.delete(projectRoot)
      viteConfig.define ??= {}
      viteConfig.define.__VITEHUB_APP_BASE_URL__ = JSON.stringify(applicationBaseURL(config.base))
      const previousTransition = configurationTransitionByRoot.get(projectRoot) ?? Promise.resolve()
      const runTransition = async () => {
        const configuredState = configuredStateByRoot.get(projectRoot)
        const serverDirs = viteConfig[VITEHUB_SERVER_DIRS] ?? configuredState?.serverDirs
        const handlers = await prepareSources({ projectRoot, serverDirs }, viteConfig.auth === false ? false : viteConfig.auth ? true : undefined)
        const handlerKey = await generatedHandlerKey(handlers)
        if (nitroHost && !viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) {
          // Nitro initializes before post-enforced config hooks. Reconcile its routes once
          // Vite has resolved the root and server directories from all config contributions.
          assertGeneratedRoutes(nitroHost, handlers)
          const nitro = replaceConfiguredNitroContribution(nitroHost.options, handlers, nitroHostContribution)
          nitroHostContribution = {
            handlers: nitro.handlers?.filter(handler => handlers.some(generated =>
              !generated.plugin && handler.handler === generated.handler && handler.route === generated.route && handler.method === generated.method)),
            plugins: handlers.flatMap(generated => generated.plugin ? [generated.handler] : []),
          }
          nitroHost.options.handlers = nitro.handlers
          nitroHost.options.plugins = nitro.plugins
          nitroHandlers.splice(0, nitroHandlers.length, ...handlers)
          nitroHost.routing.sync()
        }
        configuredStateByRoot.set(projectRoot, {
          configuredAuth: viteConfig.auth === false ? false : viteConfig.auth ? true : undefined,
          handlerKey,
          nitroContribution: configuredState?.nitroContribution,
          serverDirs: serverDirs?.slice(),
        })
        if (!viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) {
          viteConfig.nitro = replaceConfiguredNitroContribution(
            viteConfig.nitro,
            handlers,
            configuredState?.nitroContribution,
          )
        }
      }
      const transition = previousTransition.then(runTransition, runTransition)
      configurationTransitionByRoot.set(projectRoot, transition)
      void transition.finally(() => {
        if (configurationTransitionByRoot.get(projectRoot) === transition) {
          configurationTransitionByRoot.delete(projectRoot)
        }
      }).catch(() => {})
      return transition
    },
    configureServer(server) {
      // SAFETY: SourcePluginConfig only adds ViteHub's symbol-keyed metadata to Vite's resolved config.
      const viteConfig = server.config as SourcePluginConfig
      const root = viteConfig[VITEHUB_PROJECT_ROOT]
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(server.config.root ?? latestProjectRoot ?? process.cwd())
      const configuredState = configuredStateByRoot.get(root)
      const lifecycleServerDirs = configuredState?.serverDirs?.slice()
      let activeHandlerKey = configuredState?.handlerKey ?? "[]"
      const effectiveServerDirs = lifecycleServerDirs === undefined
        ? root ? [resolve(root, "server")] : []
        : root ? lifecycleServerDirs.map(directory => resolve(root, directory)) : []
      server.watcher.add(effectiveServerDirs)
      let hostRefreshRetry: ReturnType<typeof setTimeout> | undefined
      let pausedHostRefreshRetryFile: string | undefined
      let hostRefreshRetryDelay = initialHostRefreshRetryDelay
      let refreshQueue = Promise.resolve()
      let serverClosed = false
      let serverPaused = false
      const clearHostRefreshRetry = () => {
        if (hostRefreshRetry) clearTimeout(hostRefreshRetry)
        hostRefreshRetry = undefined
      }
      const closeHostRefresh = () => {
        serverClosed = true
        clearHostRefreshRetry()
        if (root && hostRefreshLifecycleByRoot.get(root)?.close === closeHostRefresh) {
          hostRefreshLifecycleByRoot.delete(root)
        }
      }
      if (root) {
        hostRefreshLifecycleByRoot.get(root)?.close()
        hostRefreshLifecycleByRoot.set(root, {
          close: closeHostRefresh,
          pause: () => { serverPaused = true },
          resume: () => {
            serverPaused = false
            if (pausedHostRefreshRetryFile) {
              const file = pausedHostRefreshRetryFile
              pausedHostRefreshRetryFile = undefined
              scheduleHostRefreshRetry(file)
            }
          },
        })
      }
      for (const environment of Object.values(server.environments)) {
        closeHostRefreshByEnvironment.set(environment, closeHostRefresh)
      }
      const scheduleHostRefreshRetry = (file: string) => {
        if (hostRefreshRetry) return
        hostRefreshRetry = setTimeout(() => {
          hostRefreshRetry = undefined
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          void queueHostRefresh(file)
        }, hostRefreshRetryDelay)
        hostRefreshRetry.unref?.()
        hostRefreshRetryDelay = Math.min(hostRefreshRetryDelay * 2, maximumHostRefreshRetryDelay)
      }
      function queueHostRefresh(file: string) {
        if (serverClosed || !root || !sourceDefinitionPath(file, root, lifecycleServerDirs)) return
        if (serverPaused) {
          pausedHostRefreshRetryFile = file
          return
        }
        const result = refreshQueue.then(async () => {
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          const previousArtifacts = await snapshotGeneratedSourceArtifacts(root)
          const handlers = await prepareSources({ projectRoot: root, serverDirs: lifecycleServerDirs })
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          const handlerKey = await generatedHandlerKey(handlers)
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          if (handlerKey === activeHandlerKey) return
          const listeners = [...generatedHandlersListeners].filter(listenerOptions =>
            listenerOptions.projectRoot === root,
          )
          const passiveListeners = listeners.filter(listenerOptions =>
            !listenerOptions.handlesHostRestart,
          )
          for (const { listener } of passiveListeners) {
            void Promise.resolve()
              .then(() => listener(handlers))
              .catch(error => server.config.logger.error(String(error)))
          }
          const hostRestartOwners = listeners.filter(listenerOptions =>
            listenerOptions.handlesHostRestart,
          )
          const listenerResults = hostRestartOwners.map(async ({ listener }) => {
            try {
              await listener(handlers)
              return true
            }
            catch (error) {
              server.config.logger.error(String(error))
              return false
            }
          })
          let ownerSettlementTimeout: ReturnType<typeof setTimeout> | undefined
          const ownerSettlement = Promise.race([
            Promise.all(listenerResults).then(results => results.some(Boolean)),
            Promise.any(listenerResults.map(async result => (await result) || Promise.reject())).then(
              () => true,
              () => false,
            ),
            new Promise<false>((resolve) => {
              ownerSettlementTimeout = setTimeout(() => resolve(false), hostRestartOwnerSettlementTimeout)
              ownerSettlementTimeout.unref?.()
            }),
          ])
          const hostRestartHandled = await ownerSettlement
          if (ownerSettlementTimeout) clearTimeout(ownerSettlementTimeout)
          if (serverClosed) return
          const hasHostRestartOwner = hostRestartOwners.length > 0
          if (hasHostRestartOwner && !hostRestartHandled) {
            await restoreGeneratedSourceArtifacts(root, previousArtifacts)
            scheduleHostRefreshRetry(file)
            return
          }
          if (!hasHostRestartOwner) {
            const previousEnvironments = server.environments
            try {
              await server.restart()
            }
            catch (error) {
              if (serverClosed) return
              await restoreGeneratedSourceArtifacts(root, previousArtifacts)
              scheduleHostRefreshRetry(file)
              throw error
            }
            if (serverClosed) return
            if (server.environments === previousEnvironments) {
              await restoreGeneratedSourceArtifacts(root, previousArtifacts)
              scheduleHostRefreshRetry(file)
              return
            }
          }
          activeHandlerKey = handlerKey
          clearHostRefreshRetry()
          hostRefreshRetryDelay = initialHostRefreshRetryDelay
        })
        refreshQueue = result.catch(() => {})
        void result.catch(error => server.config.logger.error(String(error)))
        return result
      }
      const refreshHost = (file: string) => {
        if (!root || !sourceDefinitionPath(file, root, lifecycleServerDirs)) return
        clearHostRefreshRetry()
        hostRefreshRetryDelay = initialHostRefreshRetryDelay
        return queueHostRefresh(file)
      }
      server.watcher.on("add", refreshHost)
      server.watcher.on("change", refreshHost)
      server.watcher.on("unlink", refreshHost)
    },
    buildStart() {
      // SAFETY: SourcePluginConfig only adds ViteHub's symbol-keyed metadata to the hook config.
      return refresh(this.environment?.config as SourcePluginConfig | undefined)
    },
    buildEnd() {
      // SAFETY: SourcePluginConfig only adds ViteHub's symbol-keyed metadata to the hook config.
      return refresh(this.environment?.config as SourcePluginConfig | undefined)
    },
    closeBundle() {
      closeHostRefreshByEnvironment.get(this.environment)?.()
      closeHostRefreshByEnvironment.delete(this.environment)
    },
  }
}
