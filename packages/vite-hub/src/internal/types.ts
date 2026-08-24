import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  resolveViteHubProjectRoot,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { findExportNames } from "mlly"

import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const viteHubTypesEntry = ".vitehub/types.d.ts"
const collectionTypesEntry = ".vitehub/source/collections.d.ts"
const collectionRoutesDirectory = ".vitehub/source/routes"
const contentRouteEntry = ".vitehub/content/route.mjs"

export interface GeneratedServerHandler {
  handler: string
  method?: "get"
  route: string
}

interface NitroGeneratedConfig {
  handlers?: Array<{
    handler: string
    method?: string
    route?: string
  }>
  modules?: unknown[]
}

interface NitroRouteGuard {
  hooks: {
    hook(name: "build:before", callback: () => void): void
  }
  scannedHandlers: Array<{
    method?: string
    route?: string
  }>
}

function generatedRouteOwner(handler: GeneratedServerHandler): "Collection" | "Content" {
  return handler.route === "/api/content/**" ? "Content" : "Collection"
}

function methodsOverlap(left: string | undefined, right: string | undefined): boolean {
  return !left || !right || left.toLowerCase() === right.toLowerCase()
}

function generatedRouteDescription(handler: GeneratedServerHandler): string {
  return handler.method ? `${handler.method.toUpperCase()} handler` : "handler"
}

function generatedRouteGuard(generatedHandlers: GeneratedServerHandler[]) {
  return {
    name: "vite-hub/generated-route-guard",
    setup(nitro: NitroRouteGuard) {
      nitro.hooks.hook("build:before", () => {
        for (const generatedHandler of generatedHandlers) {
          const duplicate = nitro.scannedHandlers.some(
            candidate =>
              candidate.route === generatedHandler.route &&
              methodsOverlap(candidate.method, generatedHandler.method),
          )
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

export function mergeGeneratedNitroConfig(
  value: unknown,
  generatedHandlers: GeneratedServerHandler[],
): NitroGeneratedConfig {
  const nitro: NitroGeneratedConfig = {}
  if (Object(value) === value && !Array.isArray(value)) Object.assign(nitro, value)
  if (generatedHandlers.length === 0) return nitro
  const handlers = Array.isArray(nitro.handlers) ? [...nitro.handlers] : []

  for (const handler of generatedHandlers) {
    const exact = handlers.some(
      candidate =>
        candidate.handler === handler.handler &&
        candidate.route === handler.route &&
        candidate.method?.toLowerCase() === handler.method?.toLowerCase(),
    )
    if (exact) continue
    const duplicate = handlers.some(
      candidate =>
        candidate.route === handler.route && methodsOverlap(candidate.method, handler.method),
    )
    if (duplicate) {
      throw new TypeError(
        `[vitehub] Generated ${generatedRouteOwner(handler)} route ${JSON.stringify(handler.route)} conflicts with an existing ${generatedRouteDescription(handler)}. Remove the matching server route.`,
      )
    }
    handlers.push(handler)
  }

  const modules = Array.isArray(nitro.modules) ? [...nitro.modules] : []
  if (
    !modules.some(
      module => Object(module) === module && Reflect.get(Object(module), "name") === "vite-hub/generated-route-guard",
    )
  ) {
    modules.push(generatedRouteGuard(generatedHandlers))
  }
  return { ...nitro, handlers, modules }
}

interface DiscoveredCollection {
  exportName: string
  file: string
  name: string
}

interface ViteHubTypesOptions {
  projectRoot: string
  serverDirs?: string[]
}

interface ViteHubPluginConfig {
  base?: string
  define?: Record<string, string>
  nitro?: unknown
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_SERVER_DIRS]?: string[]
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
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectCollectionFiles(path)))
    } else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

async function discoverCollections(options: ViteHubTypesOptions): Promise<DiscoveredCollection[]> {
  const { projectRoot } = options
  const serverDirs =
    options.serverDirs === undefined
      ? [resolve(projectRoot, "server")]
      : options.serverDirs.map(directory => resolve(projectRoot, directory))
  const collections = (
    await Promise.all(
      serverDirs.map(async serverDir => {
        const collectionsDirectory = resolve(serverDir, "collections")
        const files = (await collectCollectionFiles(collectionsDirectory)).sort()
        return await Promise.all(
          files.map(async file => {
            const extension = extname(file)
            const exportName = basename(file, extension)
            if (!/^[A-Z_$][\w$]*$/i.test(exportName)) {
              throw new TypeError(
                `[vitehub] Collection file ${JSON.stringify(relative(projectRoot, file))} must use a valid JavaScript identifier as its filename.`,
              )
            }
            const name = relative(collectionsDirectory, file).slice(0, -extension.length).replaceAll("\\", "/")
            const source = await readFile(file, "utf8")
            if (!findExportNames(source).includes(exportName)) {
              throw new TypeError(
                `[vitehub] Collection file ${JSON.stringify(relative(projectRoot, file))} must export a Collection named ${JSON.stringify(exportName)} to match its filename.`,
              )
            }
            return { exportName, file, name }
          }),
        )
      }),
    )
  )
    .flat()
    .sort((left, right) => left.name.localeCompare(right.name))

  const generatedPaths = new Map<string, DiscoveredCollection>()
  for (const collection of collections) {
    const generatedPath = `${collection.name}.mjs`.replaceAll("\\", "/").toLowerCase()
    const previous = generatedPaths.get(generatedPath)
    if (previous?.name === collection.name) {
      throw new TypeError(
        `[vitehub] Collection name ${JSON.stringify(collection.name)} is defined in more than one server directory.`,
      )
    }
    if (previous) {
      const [firstName, secondName] = [previous.name, collection.name].sort()
      throw new TypeError(
        `[vitehub] Collection names ${JSON.stringify(firstName)} and ${JSON.stringify(secondName)} generate the same route module on case-insensitive filesystems.`,
      )
    }
    generatedPaths.set(generatedPath, collection)
  }
  return collections
}

async function writeCollectionArtifacts(options: ViteHubTypesOptions): Promise<GeneratedServerHandler[]> {
  const collections = await discoverCollections(options)
  const output = resolve(options.projectRoot, collectionTypesEntry)
  const routesDirectory = resolve(options.projectRoot, collectionRoutesDirectory)
  await rm(routesDirectory, { force: true, recursive: true })
  if (collections.length === 0) {
    await rm(output, { force: true })
    return []
  }

  await writeFileIfChanged(
    output,
    [
      `declare global {`,
      `  interface ViteHubCollectionMap {`,
      ...collections.map(({ exportName, file, name }) => {
        const specifier = toTypeModuleSpecifier(file)
        return `    ${JSON.stringify(name)}: typeof import(${JSON.stringify(specifier)})[${JSON.stringify(exportName)}]`
      }),
      `  }`,
      `}`,
      ``,
      `export {}`,
      ``,
    ].join("\n"),
  )

  return await Promise.all(
    collections.map(async ({ exportName, file, name }) => {
      const handler = resolve(routesDirectory, `${name}.mjs`)
      const specifier = toRuntimeModuleSpecifier(file)
      await writeFileIfChanged(
        handler,
        [
          `import { defineCollectionHandler } from "vite-hub/source/server"`,
          `import { ${exportName} as collection } from ${JSON.stringify(specifier)}`,
          ``,
          `export default defineCollectionHandler(collection)`,
          ``,
        ].join("\n"),
      )
      return {
        handler,
        method: "get" as const,
        route: `/api/${name.split("/").map(encodeURIComponent).join("/")}`,
      }
    }),
  )
}

async function discoverContent(options: ViteHubTypesOptions): Promise<string | undefined> {
  const serverDirs = options.serverDirs === undefined
    ? [resolve(options.projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  const candidates: string[] = []

  for (const serverDir of serverDirs) {
    let entries
    try {
      entries = await readdir(serverDir, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue
      throw error
    }
    candidates.push(...entries
      .filter(entry => entry.isFile() && /^content\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name))
      .map(entry => join(serverDir, entry.name)))
  }

  candidates.sort()
  if (candidates.length > 1) {
    throw new TypeError("[vitehub] Content is defined in more than one server directory.")
  }
  const file = candidates[0]
  if (!file) return
  if (!findExportNames(await readFile(file, "utf8")).includes("content")) {
    throw new TypeError(
      `[vitehub] Content file ${JSON.stringify(relative(options.projectRoot, file))} must export a Comark Content instance named "content".`,
    )
  }
  return file
}

async function writeContentArtifact(options: ViteHubTypesOptions): Promise<GeneratedServerHandler[]> {
  const output = resolve(options.projectRoot, contentRouteEntry)
  const file = await discoverContent(options)
  if (!file) {
    await rm(output, { force: true })
    return []
  }

  await writeFileIfChanged(
    output,
    [
      `import { defineContentHandler } from "vite-hub/source/content"`,
      `import { content } from ${JSON.stringify(toRuntimeModuleSpecifier(file))}`,
      ``,
      `export default defineContentHandler(content)`,
      ``,
    ].join("\n"),
  )
  return [{ handler: output, route: "/api/content/**" }]
}

async function collectGeneratedTypeFiles(directory: string, root = directory): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !(directory === root && entry.name === "data")) {
      files.push(...(await collectGeneratedTypeFiles(path, root)))
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      const generatedPath = relative(root, path).replaceAll("\\", "/")
      if (generatedPath !== "types.d.ts") files.push(generatedPath)
    }
  }
  return files
}

async function writeFileIfChanged(path: string, contents: string): Promise<void> {
  let current: string | undefined
  try {
    current = await readFile(path, "utf8")
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error
  }
  if (current === contents) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

function isString(value: unknown): value is string {
  return String(value) === value
}

function applicationBaseURL(base: string | undefined): string {
  return base?.startsWith("/") && !base.startsWith("//") ? base : "/"
}

async function writeViteHubTypes(input: string | ViteHubTypesOptions): Promise<GeneratedServerHandler[]> {
  const options = isString(input) ? { projectRoot: input } : input
  const handlers = [
    ...await writeCollectionArtifacts(options),
    ...await writeContentArtifact(options),
  ].sort((left, right) => left.route.localeCompare(right.route))
  const directory = resolve(options.projectRoot, ".vitehub")
  const files = (await collectGeneratedTypeFiles(directory)).sort()
  const references = files.map(file => `/// <reference path="./${file}" />`).join("\n")
  await writeFileIfChanged(
    resolve(options.projectRoot, viteHubTypesEntry),
    `${references}${references ? "\n\n" : ""}export {}\n`,
  )
  return handlers
}

export function viteHubTypesPlugin(): Plugin &
  ViteHubCliContributingPlugin & {
    api: { prepareTypes: typeof writeViteHubTypes }
  } {
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  const refreshGeneratedTypes = async () => {
    if (projectRoot) await writeViteHubTypes({ projectRoot, serverDirs })
  }

  return {
    name: "vite-hub/types",
    enforce: "post",
    api: {
      prepareTypes: writeViteHubTypes,
    },
    async config(config) {
      const rawConfig: unknown = config
      // SAFETY: Vite plugin composition adds these symbol-keyed ViteHub fields to UserConfig.
      const viteConfig = rawConfig as ViteHubPluginConfig
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      projectRoot = resolveViteHubProjectRoot(viteConfig.root || process.cwd())
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const handlers = await writeViteHubTypes({ projectRoot, serverDirs })
      viteConfig.define = {
        ...viteConfig.define,
        __VITEHUB_APP_BASE_URL__: JSON.stringify(applicationBaseURL(viteConfig.base)),
      }
      viteConfig.nitro = mergeGeneratedNitroConfig(viteConfig.nitro, handlers)
    },
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
      const rawConfig: unknown = config
      // SAFETY: ViteHub adds these symbol-keyed fields before Vite resolves the config.
      const viteConfig = rawConfig as ViteHubPluginConfig
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const handlers = await writeViteHubTypes({ projectRoot, serverDirs })
      if (!viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) {
        viteConfig.nitro = mergeGeneratedNitroConfig(viteConfig.nitro, handlers)
      }
    },
    buildStart: refreshGeneratedTypes,
    buildEnd: refreshGeneratedTypes,
    vitehub: {
      cli: {
        namespaces: [
          {
            description: "Generate ViteHub TypeScript declarations.",
            features: [
              {
                description: "Prepare generated declarations for editors and type checking.",
                name: "prepare",
                async run(_args, context) {
                  const root = projectRoot || resolveViteHubProjectRoot(context.rootDir)
                  await writeViteHubTypes({ projectRoot: root, serverDirs })
                  context.stdout.write(`types: prepared ${viteHubTypesEntry}\n`)
                },
                usage: "vitehub types prepare",
              },
            ],
            name: "types",
          },
        ],
      },
    },
  }
}
