import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createJiti } from "jiti"

import { CodemodError } from "../types.ts"
import { isRecord } from "@vite-hub/internal/object"

/** The `createEnv()` options that the codemod reads. */
export interface T3EnvOptions {
  /** Name of the export that holds the env object, such as `env`. */
  exportName: string
  server: Record<string, unknown>
  client: Record<string, unknown>
  shared: Record<string, unknown>
  /** Other option names, such as `extends` or `skipValidation`. */
  otherOptions: string[]
}

const marker = "__vitehubT3EnvOptions"

/**
 * Imports the env module with a `createEnv()` stub, so the schemas load without validating the current
 * environment. Packages that the module imports resolve from the project.
 */
export async function loadT3EnvOptions(cwd: string, file: string): Promise<T3EnvOptions> {
  const stubDirectory = await mkdtemp(join(tmpdir(), "vitehub-t3-env-"))
  const stub = join(stubDirectory, "env-nuxt.mjs")
  await writeFile(stub, `export function createEnv(options) { return { ${JSON.stringify(marker)}: options } }\n`)
  try {
    const path = join(cwd, file)
    const jiti = createJiti(path, {
      moduleCache: false,
      fsCache: false,
      interopDefault: false,
      alias: { "@t3-oss/env-nuxt": stub, "@t3-oss/env-core": stub },
    })
    let loaded: unknown
    try {
      loaded = await jiti.import(path)
    }
    catch (error) {
      throw new CodemodError(`Cannot load ${file} to read its schemas: ${error instanceof Error ? error.message : String(error)}. Install the app dependencies, then run the codemod again.`)
    }
    if (!isRecord(loaded)) throw new CodemodError(`${file} exports no createEnv() result.`)
    for (const [exportName, value] of Object.entries(loaded)) {
      if (!isRecord(value) || !isRecord(value[marker])) continue
      const options = value[marker]
      const section = (name: string) => isRecord(options[name]) ? options[name] : {}
      return {
        exportName,
        server: section("server"),
        client: section("client"),
        shared: section("shared"),
        otherOptions: Object.keys(options).filter(name => !["server", "client", "shared"].includes(name)),
      }
    }
    throw new CodemodError(`${file} exports no createEnv() result. The codemod reads \`export const env = createEnv({ ... })\`.`)
  }
  finally {
    await rm(stubDirectory, { recursive: true, force: true })
  }
}
