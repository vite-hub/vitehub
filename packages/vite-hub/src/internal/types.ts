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

export interface GeneratedCollectionHandler {
  handler: string
  method: "get"
  route: string
}

interface NitroCollectionConfig {
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

function collectionRouteGuard(collectionHandlers: GeneratedCollectionHandler[]) {
  return {
    name: "vite-hub/collection-route-guard",
    setup(nitro: NitroRouteGuard) {
      nitro.hooks.hook("build:before", () => {
        for (const collectionHandler of collectionHandlers) {
          const duplicate = nitro.scannedHandlers.some(
            candidate =>
              candidate.route === collectionHandler.route &&
              (!candidate.method || candidate.method.toLowerCase() === collectionHandler.method),
          )
          if (duplicate) {
            throw new TypeError(
              `[vitehub] Generated Collection route ${JSON.stringify(collectionHandler.route)} conflicts with an existing GET handler. Remove the matching server route.`,
            )
          }
        }
      })
    },
  }
}

export function mergeGeneratedCollectionNitroConfig(
  value: unknown,
  collectionHandlers: GeneratedCollectionHandler[],
): NitroCollectionConfig {
  const nitro: NitroCollectionConfig = {}
  if (Object(value) === value && !Array.isArray(value)) Object.assign(nitro, value)
  if (collectionHandlers.length === 0) return nitro
  const handlers = Array.isArray(nitro.handlers) ? [...nitro.handlers] : []

  for (const handler of collectionHandlers) {
    const exact = handlers.some(
      candidate =>
        candidate.handler === handler.handler &&
        candidate.route === handler.route &&
        candidate.method?.toLowerCase() === handler.method,
    )
    if (exact) continue
    const duplicate = handlers.some(
      candidate =>
        candidate.route === handler.route && (!candidate.method || candidate.method.toLowerCase() === handler.method),
    )
    if (duplicate) {
      throw new TypeError(
        `[vitehub] Generated Collection route ${JSON.stringify(handler.route)} conflicts with an existing GET handler. Remove the matching server route.`,
      )
    }
    handlers.push(handler)
  }

  const modules = Array.isArray(nitro.modules) ? [...nitro.modules] : []
  if (
    !modules.some(
      module => Object(module) === module && Reflect.get(Object(module), "name") === "vite-hub/collection-route-guard",
    )
  ) {
    modules.push(collectionRouteGuard(collectionHandlers))
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
    } else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
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

  for (let index = 1; index < collections.length; index++) {
    if (collections[index - 1]!.name === collections[index]!.name) {
      throw new TypeError(
        `[vitehub] Collection name ${JSON.stringify(collections[index]!.name)} is defined in more than one server directory.`,
      )
    }
  }
  return collections
}

async function writeCollectionArtifacts(options: ViteHubTypesOptions): Promise<GeneratedCollectionHandler[]> {
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

async function writeViteHubTypes(input: string | ViteHubTypesOptions): Promise<GeneratedCollectionHandler[]> {
  const options = isString(input) ? { projectRoot: input } : input
  const handlers = await writeCollectionArtifacts(options)
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
        __VITEHUB_APP_BASE_URL__: JSON.stringify(viteConfig.base ?? "/"),
      }
      viteConfig.nitro = mergeGeneratedCollectionNitroConfig(viteConfig.nitro, handlers)
    },
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
      const rawConfig: unknown = config
      // SAFETY: ViteHub adds these symbol-keyed fields before Vite resolves the config.
      const viteConfig = rawConfig as ViteHubPluginConfig
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const handlers = await writeViteHubTypes({ projectRoot, serverDirs })
      if (!viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) {
        viteConfig.nitro = mergeGeneratedCollectionNitroConfig(viteConfig.nitro, handlers)
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
