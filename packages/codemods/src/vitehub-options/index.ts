import { readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { glob } from "tinyglobby"

import { codemodError } from "../error-diagnostics.ts"
import { importedConfigOptions, optionsAt } from "../shared/config-imports.ts"
import { findConfigRoot, migrateViteHubOptions } from "./transform.ts"

import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const configPatterns = ["**/{vite,nuxt}.config.{ts,mts,cts,js,mjs,cjs}"]
const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

const renamedTypes: Record<string, string> = {
  AgentModuleOptions: "AgentOptions",
  AuthModuleOptions: "AuthOptions",
  BlobModuleOptions: "BlobOptions",
  BrowserModuleOptions: "BrowserOptions",
  ChannelsVitePluginOptions: "ChannelsOptions",
  DBModulePublicOptions: "DatabaseOptions",
  EmailVitePluginOptions: "EmailOptions",
  EnvConfigOptions: "EnvDeclarations",
  EnvIntegrationOptions: "EnvOptions",
  EnvViteConfigOptions: "EnvDeclarations",
  EnvViteUserConfig: "EnvOptions, passed to vitehub({ env })",
  KVModuleOptions: "KVOptions",
  LogsEvlogOptions: "ObservabilityEvlogOptions",
  ObservabilityLogsOptions: "LogsOptions",
  QueueModuleOptions: "QueueOptions",
  RateLimitModuleOptions: "RateLimitOptions",
  RealtimeModuleOptions: "RealtimeOptions",
  SandboxTaskPublicOptions: "SandboxTaskOptions",
  ScheduleVitePluginOptions: "ScheduleOptions",
  ViteHubAgentOptions: "AgentOptions",
  ViteHubCloudflareOptions: "nothing: `vitehub deploy` uploads the Worker secrets",
  ViteHubConfig: "nothing: set the host in vitehub({ host })",
  ViteHubConnectionsOptions: "ConnectionsOptions",
  WorkflowModuleOptions: "WorkflowOptions",
  WorkspaceModuleOptions: "WorkspaceOptions",
}
const renamedTypePattern = new RegExp(`\\b(${Object.keys(renamedTypes).join("|")})\\b`, "gu")

async function configFiles(cwd: string): Promise<string[]> {
  return (await glob(configPatterns, { cwd, ignore: ignored })).sort()
}

async function migrations(cwd: string) {
  const files = await configFiles(cwd)
  const imported = importedConfigOptions(cwd, files, (program, file) => findConfigRoot(program, [], file))
  const results = []
  for (const file of files) {
    const before = await readFile(join(cwd, file), "utf8")
    const directory = dirname(file)
    const hasLocalNuxtLayers = basename(file).startsWith("nuxt.config") && (
      basename(dirname(directory)) === "layers"
      || (await glob("layers/*", { cwd: join(cwd, directory), onlyDirectories: true })).length > 0
    )
    results.push({ before, file, result: migrateViteHubOptions(file, before, { hasLocalNuxtLayers }) })
  }
  for (const [file, positions] of [...imported.options.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const before = await readFile(join(cwd, file), "utf8")
    results.push({ before, file, result: migrateViteHubOptions(file, before, { findOptions: program => optionsAt(program, positions) }) })
  }
  return { results, followUps: imported.followUps }
}

async function renamedTypeReferences(cwd: string): Promise<FollowUp[]> {
  const followUps: FollowUp[] = []
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignored })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!code.includes("vite-hub")) continue
    code.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(renamedTypePattern)) {
        followUps.push({ file, line: index + 1, message: `${match[1]} is now ${renamedTypes[match[1]!]}.` })
      }
    })
  }
  return followUps
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const { results, followUps } = await migrations(cwd)
  const notes: string[] = []
  for (const { before, file, result } of results) {
    followUps.push(...result.followUps)
    notes.push(...result.notes)
    if (result.changed) edits.push({ path: file, before, after: result.code })
  }
  followUps.push(...await renamedTypeReferences(cwd))
  if (!edits.length && !followUps.length) throw codemodError("No vite.config or nuxt.config, or a file that one imports, sets preset, sandbox, devtools, console options that moved, observability.logs, logs.evlog, contentImportBase, or a top-level env, so there is nothing to migrate.")
  return {
    summary: edits.length
      ? `Moved vite-hub options in ${edits.length} config file${edits.length === 1 ? "" : "s"}.`
      : "Found nothing to move automatically.",
    edits,
    followUps,
    notes,
    nextSteps: [],
  }
}

export const vitehubOptions: Codemod = {
  name: "vitehub-options",
  description: "Renames preset to host, moves observability.logs to logs, Env declarations into vitehub({ env }) and the Console journal options into agent.invocations, and removes devtools, contentImportBase and the Console options that left the app",
  usage: "[dir]",
  async detect({ cwd }) {
    const { results, followUps } = await migrations(cwd)
    for (const { file, result } of results) {
      if (result.changed || result.followUps.length) return { reason: `${file} uses vite-hub options that moved` }
    }
    return followUps[0] ? { reason: `${followUps[0].file} passes vite-hub options that need manual review` } : undefined
  },
  run: migrate,
}
