import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import {
  resolveViteHubProjectRoot,
  VITEHUB_NITRO_CONFIG_CONTEXT,
} from "@vite-hub/internal/build/vite"

import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const viteHubTypesEntry = ".vitehub/types.d.ts"

interface ViteHubTypesOptions {
  projectRoot: string
}

interface ViteHubPluginConfig {
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
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

async function writeViteHubTypes(input: string | ViteHubTypesOptions): Promise<void> {
  const options = typeof input === "string" ? { projectRoot: input } : input
  const directory = resolve(options.projectRoot, ".vitehub")
  const files = (await collectGeneratedTypeFiles(directory)).sort()
  const references = files.map(file => `/// <reference path="./${file}" />`).join("\n")
  await writeFileIfChanged(
    resolve(options.projectRoot, viteHubTypesEntry),
    `${references}${references ? "\n\n" : ""}export {}\n`,
  )
}

export function viteHubTypesPlugin(): Plugin &
  ViteHubCliContributingPlugin & {
    api: { prepareTypes: typeof writeViteHubTypes }
  } {
  let projectRoot: string | undefined
  const refreshGeneratedTypes = async () => {
    if (projectRoot) await writeViteHubTypes({ projectRoot })
  }

  return {
    name: "vite-hub/types",
    enforce: "post",
    api: { prepareTypes: writeViteHubTypes },
    async config(config) {
      const viteConfig = config as ViteHubPluginConfig
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      projectRoot = resolveViteHubProjectRoot(viteConfig.root || process.cwd())
      await writeViteHubTypes({ projectRoot })
    },
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
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
