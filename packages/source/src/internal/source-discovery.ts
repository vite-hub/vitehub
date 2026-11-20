import { readFile } from "node:fs/promises"
import { extname, relative, resolve } from "node:path"

import { exportNames } from "@vite-hub/internal/build/scan-module"

import { sourceErrorDiagnostics } from "../error-diagnostics.ts"
import { collectCollectionFiles } from "./collection-discovery.ts"

export interface DiscoveredSource {
  file: string
  /** The path below `server/sources/` without the extension, such as `docs` or `team/handbook`. */
  name: string
}

/** Lists the Source files under `<serverDir>/sources`. Each default export is one Source. It reads the files and does not import them. */
export async function discoverSources(options: { projectRoot: string, serverDirs?: string[] }): Promise<DiscoveredSource[]> {
  const serverDirs = options.serverDirs === undefined
    ? [resolve(options.projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  const sources = (await Promise.all(serverDirs.map(async (serverDir) => {
    const directory = resolve(serverDir, "sources")
    return await Promise.all((await collectCollectionFiles(directory)).sort().map(async (file) => {
      const path = relative(options.projectRoot, file).replaceAll("\\", "/")
      if (!exportNames(await readFile(file, "utf8"), `${file}.ts`).includes("default")) {
        throw sourceErrorDiagnostics.SOURCE_FILE_DEFAULT_EXPORT_MISSING({ path })
      }
      return { file, name: relative(directory, file).slice(0, -extname(file).length).replaceAll("\\", "/") }
    }))
  }))).flat().sort((left, right) => left.name.localeCompare(right.name))

  const files = new Map<string, string>()
  for (const source of sources) {
    const previous = files.get(source.name)
    if (previous) {
      throw sourceErrorDiagnostics.SOURCE_FILE_NAME_DUPLICATE({
        files: [previous, source.file].map(file => relative(options.projectRoot, file).replaceAll("\\", "/")).join(" and "),
        name: source.name,
      })
    }
    files.set(source.name, source.file)
  }
  return sources
}
