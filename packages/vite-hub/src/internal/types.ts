import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve } from "node:path"

import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const viteHubTypesEntry = ".vitehub/types.d.ts"
const collectionTypesEntry = ".vitehub/source/collections.d.ts"

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

async function writeCollectionTypes(root: string): Promise<void> {
  const collectionsDirectory = resolve(root, "server/collections")
  const files = (await collectCollectionFiles(collectionsDirectory)).sort()
  const output = resolve(root, collectionTypesEntry)
  if (files.length === 0) {
    await rm(output, { force: true })
    return
  }

  const entries = files.map((file) => {
    const extension = extname(file)
    const exportName = basename(file, extension)
    if (!/^[A-Z_$][\w$]*$/i.test(exportName)) {
      throw new TypeError(
        `[vitehub] Collection file ${JSON.stringify(relative(root, file))} must use a valid JavaScript identifier as its filename.`,
      )
    }
    const name = relative(collectionsDirectory, file)
      .slice(0, -extension.length)
      .replaceAll("\\", "/")
    return `    ${JSON.stringify(name)}: typeof import(${JSON.stringify(file)})[${JSON.stringify(exportName)}]`
  })

  await writeFileIfChanged(output, [
    `declare global {`,
    `  interface ViteHubCollectionMap {`,
    ...entries,
    `  }`,
    `}`,
    ``,
    `export {}`,
    ``,
  ].join("\n"))
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

async function writeViteHubTypes(root: string): Promise<void> {
  await writeCollectionTypes(root)
  const directory = resolve(root, ".vitehub")
  const files = (await collectGeneratedTypeFiles(directory)).sort()
  const references = files.map(file => `/// <reference path="./${file}" />`).join("\n")
  await writeFileIfChanged(
    resolve(root, viteHubTypesEntry),
    `${references}${references ? "\n\n" : ""}export {}\n`,
  )
}

export function viteHubTypesPlugin(): Plugin & ViteHubCliContributingPlugin & {
  api: { prepareTypes: typeof writeViteHubTypes }
} {
  let projectRoot: string | undefined
  const refreshGeneratedTypes = async () => {
    if (projectRoot) await writeViteHubTypes(projectRoot)
  }

  return {
    name: "vite-hub/types",
    enforce: "post",
    api: {
      prepareTypes: writeViteHubTypes,
    },
    async configResolved(config) {
      projectRoot = resolveViteHubProjectRoot(config.root)
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
              await writeViteHubTypes(root)
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
