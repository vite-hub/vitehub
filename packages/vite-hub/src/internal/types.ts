import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import {
  resolveViteHubProjectRoot,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { prepareSourceGeneration } from "@vite-hub/source/vite"

import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const viteHubTypesEntry = ".vitehub/types.d.ts"

interface ViteHubTypesOptions {
  projectRoot: string
}

interface ViteHubTypesPluginOptions {
  prepareSources?: (options: { projectRoot: string; serverDirs?: string[] }) => Promise<unknown>
}

interface ViteHubPluginConfig {
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_SERVER_DIRS]?: string[]
}

async function collectGeneratedTypeFiles(directory: string, root = directory): Promise<string[]> {
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
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error
  }
  if (current === contents) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

async function writeViteHubTypes(options: ViteHubTypesOptions): Promise<void> {
  const directory = resolve(options.projectRoot, ".vitehub")
  const files = (await collectGeneratedTypeFiles(directory)).sort()
  const references = files.map(file => `/// <reference path="./${file}" />`).join("\n")
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
  let prepareSources = options.prepareSources
  let serverDirs: string[] | undefined
  const refreshGeneratedTypes = async () => {
    if (!projectRoot) return
    if (prepareSources) await prepareSources({ projectRoot, serverDirs })
    await writeViteHubTypes({ projectRoot })
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
      projectRoot = resolveViteHubProjectRoot(viteConfig.root || process.cwd())
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      await writeViteHubTypes({ projectRoot })
    },
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
      // SAFETY: Vite's resolved config retains the ViteHub symbols added during the config hook.
      serverDirs = (config as ViteHubPluginConfig)[VITEHUB_SERVER_DIRS]
      await writeViteHubTypes({ projectRoot })
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
              await writeViteHubTypes({ projectRoot: root })
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
