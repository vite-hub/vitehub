import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

/**
 * Build-time facts about an Agent module that a package declares in its package.json:
 *
 * ```json
 * { "vitehub": { "agent": { "processHost": ["./babysitter"], "providerDriver": ["./babysitter", "./workspace"] } } }
 * ```
 *
 * - `processHost`: the subpath attaches a process host to the Agent (see `@vite-hub/agent/process-host`).
 * - `providerDriver`: the subpath selects a provider Agent Driver, such as Codex or Claude Code.
 *
 * The Vite plugin reads these lists when an Agent module imports the subpath, so that it does not
 * need to know the package.
 */
export type AgentModuleTrait = "processHost" | "providerDriver"

type AgentModuleTraits = Partial<Record<AgentModuleTrait, readonly string[]>>

const manifests = new Map<string, AgentModuleTraits>()

function packageSpecifier(specifier: string): { name: string, subpath: string } | undefined {
  if (/^(?:[./#]|[a-z][a-z\d+.-]*:)/i.test(specifier)) return
  const parts = specifier.split("/")
  const size = specifier.startsWith("@") ? 2 : 1
  if (parts.length < size || parts.slice(0, size).some(part => !part)) return
  const rest = parts.slice(size)
  return { name: parts.slice(0, size).join("/"), subpath: rest.length ? `./${rest.join("/")}` : "." }
}

function readTraits(manifestPath: string): AgentModuleTraits {
  const cached = manifests.get(manifestPath)
  if (cached) return cached
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  const vitehub = isRuntimeRecord(manifest) ? manifest.vitehub : undefined
  const agent = isRuntimeRecord(vitehub) ? vitehub.agent : undefined
  const traits: AgentModuleTraits = {}
  if (isRuntimeRecord(agent)) {
    for (const trait of ["processHost", "providerDriver"] as const) {
      const value = agent[trait]
      if (Array.isArray(value)) traits[trait] = value.filter(item => hasRuntimeType(item, "string"))
    }
  }
  manifests.set(manifestPath, traits)
  return traits
}

/** Whether `specifier`, imported from the file `importer`, names a package subpath that declares `trait`. */
export function hasAgentModuleTrait(specifier: string, importer: string, trait: AgentModuleTrait): boolean {
  const target = packageSpecifier(specifier)
  if (!target) return false
  for (let directory = dirname(importer); ; directory = dirname(directory)) {
    const manifestPath = join(directory, "node_modules", target.name, "package.json")
    if (manifests.has(manifestPath) || existsSync(manifestPath)) return readTraits(manifestPath)[trait]?.includes(target.subpath) ?? false
    if (dirname(directory) === directory) return false
  }
}
