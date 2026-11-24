import { existsSync } from "node:fs"
import { join } from "node:path"

import { codemodsErrorDiagnostics } from "../error-diagnostics.ts"
import { readDependencies } from "../shared/detect.ts"
import { findNuxtConfigName } from "../shared/nuxt-config.ts"

const configNames = ["nitro.config.ts", "nitro.config.mts", "nitro.config.js", "nitro.config.mjs", "nitro.config.cjs"]

/** The file name of the project's nitro.config, or `undefined` when it has none. */
export function findNitroConfigName(cwd: string): string | undefined {
  return configNames.find(name => existsSync(join(cwd, name)))
}

/** Stops a Nitro app without a nuxt.config that runs on Nitro 2 (`nitropack`), before the codemod plans any edit. */
export async function assertNotNitro2(cwd: string, codemod: string): Promise<void> {
  if (findNuxtConfigName(cwd)) return
  const config = findNitroConfigName(cwd)
  if (!config) return
  const dependencies = await readDependencies(cwd)
  const nitropack = dependencies.get("nitropack")
  if (nitropack === undefined || dependencies.has("nitro")) return
  throw codemodsErrorDiagnostics.CODEMODS_NITRO_UNSUPPORTED({ codemod, config, nitropack })
}
