import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  resolveViteHubProjectRoot,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { findExportNames } from "mlly"

import type { Plugin } from "vite"

const collectionTypesEntry = ".vitehub/types/source/collections.d.ts"
const legacyCollectionTypesEntry = ".vitehub/source/collections.d.ts"
const collectionRoutesDirectory = ".vitehub/source/routes"
const contentRouteEntry = ".vitehub/content/route.mjs"

export interface GeneratedSourceHandler {
  handler: string
  method?: "get"
  route: string
}

export interface SourceGenerationOptions {
  importBase?: string
  projectRoot: string
  serverDirs?: string[]
}

export interface SourceVitePluginOptions {
  importBase?: string
}

export type GeneratedSourceHandlersListener = (handlers: GeneratedSourceHandler[]) => Promise<void> | void

export interface GeneratedSourceHandlersListenerOptions {
  handlesHostRestart?: boolean
}

interface DiscoveredCollection {
  exportName: string
  file: string
  name: string
}

interface NitroGeneratedConfig {
  handlers?: Array<{ handler: string, method?: string, route?: string }>
  modules?: unknown[]
}

interface NitroRouteGuard {
  hooks: { hook(name: "build:before", callback: () => void): void }
  scannedHandlers: Array<{ method?: string, route?: string }>
}

interface SourcePluginConfig {
  base?: string
  define?: Record<string, string>
  nitro?: unknown
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_SERVER_DIRS]?: string[]
}

function methodsOverlap(left: string | undefined, right: string | undefined): boolean {
  return !left || !right || left.toLowerCase() === right.toLowerCase()
}

function generatedRouteOwner(handler: GeneratedSourceHandler): "Collection" | "Content" {
  return handler.route === "/api/content/**" ? "Content" : "Collection"
}

function generatedRouteDescription(handler: GeneratedSourceHandler): string {
  return handler.method ? `${handler.method.toUpperCase()} handler` : "handler"
}

function generatedRouteGuard(generatedHandlers: GeneratedSourceHandler[]) {
  return {
    name: "vite-hub/generated-route-guard",
    setup(nitro: NitroRouteGuard) {
      nitro.hooks.hook("build:before", () => {
        for (const generatedHandler of generatedHandlers) {
          const duplicate = nitro.scannedHandlers.some(candidate =>
            candidate.route === generatedHandler.route
            && methodsOverlap(candidate.method, generatedHandler.method))
          if (duplicate) {
            throw new TypeError(
              `[vitehub] Generated ${generatedRouteOwner(generatedHandler)} route ${JSON.stringify(generatedHandler.route)} conflicts with an existing ${generatedRouteDescription(generatedHandler)}. Remove the matching server route.`,
            )
          }
        }
      })
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
  const handlers = Array.isArray(nitro.handlers) ? [...nitro.handlers] : []

  for (const handler of generatedHandlers) {
    const exact = handlers.some(candidate =>
      candidate.handler === handler.handler
      && candidate.route === handler.route
      && candidate.method?.toLowerCase() === handler.method?.toLowerCase())
    if (exact) continue
    const duplicate = handlers.some(candidate =>
      candidate.route === handler.route && methodsOverlap(candidate.method, handler.method))
    if (duplicate) {
      throw new TypeError(
        `[vitehub] Generated ${generatedRouteOwner(handler)} route ${JSON.stringify(handler.route)} conflicts with an existing ${generatedRouteDescription(handler)}. Remove the matching server route.`,
      )
    }
    handlers.push(handler)
  }

  const modules = Array.isArray(nitro.modules) ? [...nitro.modules] : []
  if (!modules.some(module =>
    Object(module) === module && Reflect.get(Object(module), "name") === "vite-hub/generated-route-guard")) {
    modules.push(generatedRouteGuard(generatedHandlers))
  }
  return { ...nitro, handlers, modules }
}

export function toRuntimeModuleSpecifier(file: string): string {
  return pathToFileURL(file, { windows: /^[A-Z]:[\\/]/i.test(file) }).href
}

export function toTypeModuleSpecifier(file: string): string {
  return file.replaceAll("\\", "/")
}

async function collectCollectionFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectCollectionFiles(path))
    else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(path)
  }
  return files
}

async function discoverCollections(options: SourceGenerationOptions): Promise<DiscoveredCollection[]> {
  const serverDirs = options.serverDirs === undefined
    ? [resolve(options.projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  const collections = (await Promise.all(serverDirs.map(async (serverDir) => {
    const directory = resolve(serverDir, "collections")
    return await Promise.all((await collectCollectionFiles(directory)).sort().map(async (file) => {
      const extension = extname(file)
      const exportName = basename(file, extension)
      if (!/^[A-Z_$][\w$]*$/i.test(exportName)) {
        throw new TypeError(`[vitehub] Collection file ${JSON.stringify(relative(options.projectRoot, file))} must use a valid JavaScript identifier as its filename.`)
      }
      const name = relative(directory, file).slice(0, -extension.length).replaceAll("\\", "/")
      if (!findExportNames(await readFile(file, "utf8")).includes(exportName)) {
        throw new TypeError(`[vitehub] Collection file ${JSON.stringify(relative(options.projectRoot, file))} must export a Collection named ${JSON.stringify(exportName)} to match its filename.`)
      }
      return { exportName, file, name }
    }))
  }))).flat().sort((left, right) => left.name.localeCompare(right.name))

  const generatedPaths = new Map<string, DiscoveredCollection>()
  for (const collection of collections) {
    const generatedPath = `${collection.name}.mjs`.toLowerCase()
    const previous = generatedPaths.get(generatedPath)
    if (previous?.name === collection.name) {
      throw new TypeError(`[vitehub] Collection name ${JSON.stringify(collection.name)} is defined in more than one server directory.`)
    }
    if (previous) {
      const [firstName, secondName] = [previous.name, collection.name].sort()
      throw new TypeError(`[vitehub] Collection names ${JSON.stringify(firstName)} and ${JSON.stringify(secondName)} generate the same route module on case-insensitive filesystems.`)
    }
    generatedPaths.set(generatedPath, collection)
  }
  return collections
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

async function writeCollectionArtifacts(options: SourceGenerationOptions): Promise<GeneratedSourceHandler[]> {
  const collections = await discoverCollections(options)
  const output = resolve(options.projectRoot, collectionTypesEntry)
  await rm(resolve(options.projectRoot, legacyCollectionTypesEntry), { force: true })
  const routesDirectory = resolve(options.projectRoot, collectionRoutesDirectory)
  if (collections.length === 0) {
    await Promise.all([rm(output, { force: true }), rm(routesDirectory, { force: true, recursive: true })])
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

  const expectedRoutes = new Set(collections.map(({ name }) => resolve(routesDirectory, `${name}.mjs`)))
  const existingRoutes = await collectCollectionFiles(routesDirectory)
  await Promise.all(existingRoutes.filter(file => !expectedRoutes.has(file)).map(file => rm(file, { force: true })))
  return await Promise.all(collections.map(async ({ exportName, file, name }) => {
    const handler = resolve(routesDirectory, `${name}.mjs`)
    await writeFileIfChanged(handler, [
      `import { defineCollectionHandler } from ${JSON.stringify(`${options.importBase ?? "@vite-hub/source"}/server`)}`,
      `import { ${exportName} as collection } from ${JSON.stringify(toRuntimeModuleSpecifier(file))}`,
      "",
      "export default defineCollectionHandler(collection)",
      "",
    ].join("\n"))
    return { handler, method: "get" as const, route: `/api/${name.split("/").map(encodeURIComponent).join("/")}` }
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
  if (candidates.length > 1) throw new TypeError("[vitehub] Content is defined in more than one server directory.")
  const file = candidates[0]
  if (!file) return
  if (!findExportNames(await readFile(file, "utf8")).includes("content")) {
    throw new TypeError(`[vitehub] Content file ${JSON.stringify(relative(options.projectRoot, file))} must export a Comark Content instance named "content".`)
  }
  return file
}

async function writeContentArtifact(options: SourceGenerationOptions): Promise<GeneratedSourceHandler[]> {
  const output = resolve(options.projectRoot, contentRouteEntry)
  const file = await discoverContent(options)
  if (!file) {
    await rm(output, { force: true })
    return []
  }
  await writeFileIfChanged(output, [
    `import { defineContentHandler } from ${JSON.stringify(`${options.importBase ?? "@vite-hub/source"}/content`)}`,
    `import { content } from ${JSON.stringify(toRuntimeModuleSpecifier(file))}`,
    "",
    "export default defineContentHandler(content)",
    "",
  ].join("\n"))
  return [{ handler: output, route: "/api/content/**" }]
}

export async function prepareSourceGeneration(options: SourceGenerationOptions): Promise<GeneratedSourceHandler[]> {
  return [
    ...await writeCollectionArtifacts(options),
    ...await writeContentArtifact(options),
  ].sort((left, right) => left.route.localeCompare(right.route))
}

function applicationBaseURL(base: string | undefined): string {
  return base?.startsWith("/") && !base.startsWith("//") ? base : "/"
}

function generatedHandlerKey(handlers: GeneratedSourceHandler[]): string {
  return JSON.stringify(handlers)
}

function sourceDefinitionPath(file: string, projectRoot: string, serverDirs: string[] | undefined): boolean {
  const directories = serverDirs === undefined ? [resolve(projectRoot, "server")] : serverDirs
  return directories.some((directory) => {
    const path = relative(resolve(projectRoot, directory), resolve(file)).replaceAll("\\", "/")
    if (path.startsWith("../") || isAbsolute(path)) return false
    return /^content\.(?:[cm]?[jt]s)$/.test(path)
      || (/^collections\/.+\.(?:[cm]?[jt]s)$/.test(path) && !/\.d\.[cm]?ts$/.test(path))
  })
}

export function hubSource(options: SourceVitePluginOptions = {}): Plugin & {
  api: {
    onGeneratedHandlersChanged: (
      listener: GeneratedSourceHandlersListener,
      options?: GeneratedSourceHandlersListenerOptions,
    ) => () => void
    prepareSources: (options: Omit<SourceGenerationOptions, "importBase">) => Promise<GeneratedSourceHandler[]>
  }
} {
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let configuredHandlerKey = generatedHandlerKey([])
  let refreshQueue = Promise.resolve()
  const generatedHandlersListeners = new Map<GeneratedSourceHandlersListener, GeneratedSourceHandlersListenerOptions>()
  const prepareSources = (input: Omit<SourceGenerationOptions, "importBase">) =>
    prepareSourceGeneration({ ...input, importBase: options.importBase })
  const refresh = async () => {
    if (projectRoot) await prepareSources({ projectRoot, serverDirs })
  }
  const onGeneratedHandlersChanged = (
    listener: GeneratedSourceHandlersListener,
    listenerOptions: GeneratedSourceHandlersListenerOptions = {},
  ) => {
    generatedHandlersListeners.set(listener, listenerOptions)
    return () => generatedHandlersListeners.delete(listener)
  }
  return {
    name: "@vite-hub/source/vite",
    enforce: "post",
    api: { onGeneratedHandlersChanged, prepareSources },
    async config(config) {
      // SAFETY: Vite passes the mutable user config object, which this plugin augments through ViteHub's shared symbols.
      const viteConfig = config as SourcePluginConfig
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      projectRoot = resolveViteHubProjectRoot(viteConfig.root || process.cwd())
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const handlers = await prepareSources({ projectRoot, serverDirs })
      configuredHandlerKey = generatedHandlerKey(handlers)
      viteConfig.define = {
        ...viteConfig.define,
        __VITEHUB_APP_BASE_URL__: JSON.stringify(applicationBaseURL(viteConfig.base)),
      }
      viteConfig.nitro = mergeGeneratedSourceNitroConfig(viteConfig.nitro, handlers)
    },
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
      // SAFETY: Vite's resolved config retains the ViteHub symbols added during the config hook.
      const viteConfig = config as SourcePluginConfig
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const handlers = await prepareSources({ projectRoot, serverDirs })
      configuredHandlerKey = generatedHandlerKey(handlers)
      if (!viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) {
        viteConfig.nitro = mergeGeneratedSourceNitroConfig(viteConfig.nitro, handlers)
      }
    },
    configureServer(server) {
      const root = projectRoot
      const effectiveServerDirs = serverDirs === undefined
        ? root ? [resolve(root, "server")] : []
        : root ? serverDirs.map(directory => resolve(root, directory)) : []
      server.watcher.add(effectiveServerDirs)
      const refreshHost = (file: string) => {
        if (!root || !sourceDefinitionPath(file, root, serverDirs)) return
        const result = refreshQueue.then(async () => {
          const handlers = await prepareSources({ projectRoot: root, serverDirs })
          const handlerKey = generatedHandlerKey(handlers)
          if (handlerKey === configuredHandlerKey) return
          const listeners = [...generatedHandlersListeners]
          const listenerResults = await Promise.allSettled(listeners.map(([listener]) => listener(handlers)))
          for (const result of listenerResults) {
            if (result.status === "rejected") server.config.logger.error(String(result.reason))
          }
          if (!listeners.some(([, listenerOptions]) => listenerOptions.handlesHostRestart)) {
            await server.restart()
          }
          configuredHandlerKey = handlerKey
        })
        refreshQueue = result.catch(() => {})
        void result.catch(error => server.config.logger.error(String(error)))
        return result
      }
      server.watcher.on("add", refreshHost)
      server.watcher.on("change", refreshHost)
      server.watcher.on("unlink", refreshHost)
    },
    buildStart: refresh,
    buildEnd: refresh,
  }
}
