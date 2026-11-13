import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { glob } from "tinyglobby"

import { CodemodError } from "../types.ts"
import { migrateViteHubOptions } from "./transform.ts"

import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const configPatterns = ["**/{vite,nuxt}.config.{ts,mts,cts,js,mjs,cjs}"]
const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

/** Option types that this release renamed or removed, with their replacement. */
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
  LogsOptions: "ObservabilityLogsOptions",
  QueueModuleOptions: "QueueOptions",
  RateLimitModuleOptions: "RateLimitOptions",
  RealtimeModuleOptions: "RealtimeOptions",
  SandboxTaskPublicOptions: "SandboxTaskOptions",
  ScheduleVitePluginOptions: "ScheduleOptions",
  ViteHubAgentOptions: "AgentOptions",
  ViteHubCloudflareOptions: "CloudflareOptions",
  ViteHubConfig: "nothing: set the host in vitehub({ host })",
  ViteHubConnectionsOptions: "ConnectionsOptions",
  WorkflowModuleOptions: "WorkflowOptions",
  WorkspaceModuleOptions: "WorkspaceOptions",
}
const renamedTypePattern = new RegExp(`\\b(${Object.keys(renamedTypes).join("|")})\\b`, "gu")

async function configFiles(cwd: string): Promise<string[]> {
  return (await glob(configPatterns, { cwd, ignore: ignored })).sort()
}

/** Source lines that name a renamed option type. The codemod reports them and edits nothing. */
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
  const followUps: FollowUp[] = []
  const notes: string[] = []
  const files = await configFiles(cwd)
  for (const file of files) {
    const before = await readFile(join(cwd, file), "utf8")
    const result = migrateViteHubOptions(file, before)
    followUps.push(...result.followUps)
    notes.push(...result.notes)
    if (result.changed) edits.push({ path: file, before, after: result.code })
  }
  followUps.push(...await renamedTypeReferences(cwd))
  if (!edits.length && !followUps.length) throw new CodemodError("No vite.config or nuxt.config sets logs, contentImportBase, or a top-level env, so there is nothing to migrate.")
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
  description: "Moves logs into observability, Env declarations into vitehub({ env }), and removes contentImportBase",
  usage: "[dir]",
  async detect({ cwd }) {
    for (const file of await configFiles(cwd)) {
      const result = migrateViteHubOptions(file, await readFile(join(cwd, file), "utf8"))
      if (result.changed || result.followUps.length) return { reason: `${file} uses vite-hub options that moved` }
    }
    return undefined
  },
  run: migrate,
}
