import { existsSync } from "node:fs"
import { join } from "node:path"

import { codemodsErrorDiagnostics } from "../error-diagnostics.ts"
import { readDependencies } from "../shared/detect.ts"
import { findNuxtConfigName } from "../shared/nuxt-config.ts"

const configNames = ["nitro.config.ts", "nitro.config.mts", "nitro.config.cts", "nitro.config.js", "nitro.config.mjs", "nitro.config.cjs"]

/** The file name of the project's nitro.config, or `undefined` when it has none. */
export function findNitroConfigName(cwd: string): string | undefined {
  return configNames.find(name => existsSync(join(cwd, name)))
}

function packageName(name: string, specifier: string): string {
  return /^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/.exec(specifier)?.[1] ?? name
}

/** Stops before planning edits for a standalone Nitro app that declares Nitro 2, including mixed manifests. */
export async function assertNotNitro2(cwd: string, codemod: string): Promise<void> {
  if (findNuxtConfigName(cwd)) return
  const config = findNitroConfigName(cwd)
  if (!config) return
  const dependencies = [...await readDependencies(cwd)]
  const legacy = dependencies.find(([name, version]) => packageName(name, version) === "nitropack")
  if (!legacy) return
  const [name, version] = legacy
  const mixed = dependencies.some(([name, version]) => packageName(name, version) === "nitro")
  const reason = mixed
    ? `Cannot determine the Nitro version for ${config}: package.json declares both nitro and nitropack.`
    : `${config} belongs to a Nitro 2 app: package.json requires ${name} "${version}".`
  throw codemodsErrorDiagnostics.CODEMODS_NITRO_UNSUPPORTED({ codemod, reason, mixed })
}
