import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import {
  resolveViteHubProjectRoot,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { prepareSourceGeneration } from "@vite-hub/source/vite"

import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const viteHubTypesEntry = ".vitehub/types.d.ts"

function isRetainedSourceDirectory(name: string): boolean {
  return name === "node_modules"
    || name === "sources"
    || name === "runtime-sources"
    || name.endsWith("-generations")
    || name.endsWith("-sources")
}

interface ViteHubTypesOptions {
  additionalProjectRoots?: string[]
  projectRoot: string
}

interface ViteHubTypesPluginOptions {
  additionalProjectRoots?: string[]
  prepareSources?: (options: { projectRoot: string; serverDirs?: string[] }) => Promise<unknown>
}

interface ViteHubPluginConfig {
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_SERVER_DIRS]?: string[]
}

function isUnresolvableDirectory(error: unknown): boolean {
  return error instanceof Error && ["ELOOP", "ENOENT"].includes(String(Reflect.get(error, "code")))
}

async function collectGeneratedTypeFiles(
  directory: string,
  root = directory,
  visitedDirectories = new Set<string>(),
): Promise<string[]> {
  const realDirectory = await realpath(directory).catch((error) => {
    if (isUnresolvableDirectory(error)) return undefined
    throw error
  })
  if (!realDirectory || visitedDirectories.has(realDirectory)) return []

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return []
    throw error
  }
  visitedDirectories.add(realDirectory)

  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(path).then(value => value.isDirectory()).catch((error) => {
      if (isUnresolvableDirectory(error)) return false
      throw error
    }))
    if (isDirectory && !(directory === root && entry.name === "data") && !isRetainedSourceDirectory(entry.name)) {
      for (const file of await collectGeneratedTypeFiles(path, root, visitedDirectories)) files.push(file)
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
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error
  }
  if (current === contents) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

async function writeViteHubTypes(options: ViteHubTypesOptions): Promise<void> {
  const directory = resolve(options.projectRoot, ".vitehub")
  const roots = [options.projectRoot, ...(options.additionalProjectRoots ?? []).map(root => resolve(options.projectRoot, root))]
  const files = [...new Set((await Promise.all(roots.map(async root => {
    const generatedDirectory = resolve(root, ".vitehub")
    return (await collectGeneratedTypeFiles(generatedDirectory)).map(file => relative(directory, join(generatedDirectory, file)).replaceAll("\\", "/"))
  }))).flat())].sort()
  const references = files.map(file => `/// <reference path="${isAbsolute(file) ? file : `./${file}`}" />`).join("\n")
  await writeFileIfChanged(
    resolve(options.projectRoot, viteHubTypesEntry),
    `${references}${references ? "\n\n" : ""}export {}\n`,
  )
}

export function viteHubTypesPlugin(options: ViteHubTypesPluginOptions = {}): Plugin &
  ViteHubCliContributingPlugin & {
    api: {
      prepareTypes: typeof writeViteHubTypes
      setPrepareSources: (prepareSources: ViteHubTypesPluginOptions["prepareSources"]) => void
    }
  } {
  let projectRoot: string | undefined
  let additionalProjectRoots = options.additionalProjectRoots
  let prepareSources = options.prepareSources
  let serverDirs: string[] | undefined
  const refreshGeneratedTypes = async () => {
    if (!projectRoot) return
    if (prepareSources) await prepareSources({ projectRoot, serverDirs })
    await writeViteHubTypes({ additionalProjectRoots, projectRoot })
  }

  return {
    name: "vite-hub/types",
    enforce: "post",
    api: {
      prepareTypes: writeViteHubTypes,
      setPrepareSources(nextPrepareSources) {
        prepareSources = nextPrepareSources
      },
    },
    async config(config) {
      // SAFETY: Vite passes the mutable user config object, which this plugin augments through ViteHub's shared symbols.
      const viteConfig = config as ViteHubPluginConfig
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      const viteRoot = viteConfig.root || process.cwd()
      projectRoot = resolveViteHubProjectRoot(viteRoot)
      additionalProjectRoots = options.additionalProjectRoots?.map(root => resolve(viteRoot, root))
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      await writeViteHubTypes({ additionalProjectRoots, projectRoot })
    },
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
      additionalProjectRoots = options.additionalProjectRoots?.map(root => resolve(config.root, root))
      // SAFETY: Vite's resolved config retains the ViteHub symbols added during the config hook.
      serverDirs = (config as ViteHubPluginConfig)[VITEHUB_SERVER_DIRS]
      await writeViteHubTypes({ additionalProjectRoots, projectRoot })
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
              if (prepareSources) await prepareSources({ projectRoot: root, serverDirs })
              else await prepareSourceGeneration({ importBase: "vite-hub/source", projectRoot: root, serverDirs })
              await writeViteHubTypes({ additionalProjectRoots, projectRoot: root })
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
