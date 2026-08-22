import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
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

interface DiscoveredCollection {
  exportName: string
  file: string
  name: string
}

interface ViteHubTypesOptions {
  projectRoot: string
  serverDirs?: string[]
}

async function collectCollectionFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectCollectionFiles(path))
    }
    else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(path)
    }
  }
  return files
}

async function discoverCollections(options: ViteHubTypesOptions): Promise<DiscoveredCollection[]> {
  const { projectRoot } = options
  const serverDirs = options.serverDirs === undefined
    ? [resolve(projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(projectRoot, directory))
  const collections = (await Promise.all(serverDirs.map(async (serverDir) => {
    const collectionsDirectory = resolve(serverDir, "collections")
    const files = (await collectCollectionFiles(collectionsDirectory)).sort()
    return await Promise.all(files.map(async (file) => {
      const extension = extname(file)
      const exportName = basename(file, extension)
      if (!/^[A-Z_$][\w$]*$/i.test(exportName)) {
        throw new TypeError(
          `[vitehub] Collection file ${JSON.stringify(relative(projectRoot, file))} must use a valid JavaScript identifier as its filename.`,
        )
      }
      const name = relative(collectionsDirectory, file)
        .slice(0, -extension.length)
        .replaceAll("\\", "/")
      const source = await readFile(file, "utf8")
      if (!findExportNames(source).includes(exportName)) {
        throw new TypeError(
          `[vitehub] Collection file ${JSON.stringify(relative(projectRoot, file))} must export a Collection named ${JSON.stringify(exportName)} to match its filename.`,
        )
      }
      return { exportName, file, name }
    }))
  }))).flat().sort((left, right) => left.name.localeCompare(right.name))

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

  await writeFileIfChanged(output, [
    `declare global {`,
    `  interface ViteHubCollectionMap {`,
    ...collections.map(({ exportName, file, name }) =>
      `    ${JSON.stringify(name)}: typeof import(${JSON.stringify(file)})[${JSON.stringify(exportName)}]`,
    ),
    `  }`,
    `}`,
    ``,
    `export {}`,
    ``,
  ].join("\n"))

  return await Promise.all(collections.map(async ({ exportName, file, name }) => {
    const handler = resolve(routesDirectory, `${name}.mjs`)
    await writeFileIfChanged(handler, [
      `import { defineCollectionHandler } from "vite-hub/source/server"`,
      `import { ${exportName} as collection } from ${JSON.stringify(file)}`,
      ``,
      `export default defineCollectionHandler(collection)`,
      ``,
    ].join("\n"))
    return {
      handler,
      method: "get" as const,
      route: `/api/${name.split("/").map(encodeURIComponent).join("/")}`,
    }
  }))
}

async function collectGeneratedTypeFiles(directory: string, root = directory): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && !(directory === root && entry.name === "data")) {
      files.push(...await collectGeneratedTypeFiles(path, root))
    }
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
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
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (current === contents) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

async function writeViteHubTypes(input: string | ViteHubTypesOptions): Promise<GeneratedCollectionHandler[]> {
  const options = typeof input === "string" ? { projectRoot: input } : input
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

export function viteHubTypesPlugin(): Plugin & ViteHubCliContributingPlugin & {
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
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      await refreshGeneratedTypes()
    },
    buildStart: refreshGeneratedTypes,
    buildEnd: refreshGeneratedTypes,
    vitehub: {
      cli: {
        namespaces: [{
          description: "Generate ViteHub TypeScript declarations.",
          features: [{
            description: "Prepare generated declarations for editors and type checking.",
            name: "prepare",
            async run(_args, context) {
              const root = projectRoot || resolveViteHubProjectRoot(context.rootDir)
              await writeViteHubTypes({ projectRoot: root, serverDirs })
              context.stdout.write(`types: prepared ${viteHubTypesEntry}\n`)
            },
            usage: "vitehub types prepare",
          }],
          name: "types",
        }],
      },
    },
  }
}
