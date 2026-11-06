import { parseArgs } from "node:util"

import { resolveHostCredentials } from "@vite-hub/internal/host-credentials"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { listCloudflareDeployments } from "./deploy/cloudflare.ts"
import { listDenoDeployments } from "./deploy/deno.ts"
import { createDeployRun } from "./deploy/host.ts"
import { listNetlifyDeployments } from "./deploy/netlify.ts"
import { listVercelDeployments } from "./deploy/vercel.ts"
import { SetupFailure, setupExitCodes, table, writeSetupError, writeSetupJson } from "./envelope.ts"
import { readSetupLink } from "./link.ts"
import { readSetupProject } from "./project.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { HostCredentials } from "@vite-hub/internal/host-credentials"
import type { DeployCommit, DeployRun, DeploymentsContext, HostDeployment, ListDeployments } from "./deploy/host.ts"
import type { SetupLink, SetupLinkHost } from "./link.ts"

const usage = "vitehub deployments [--limit <n>] [--json]"

const listers: Record<SetupLinkHost, ListDeployments> = {
  cloudflare: listCloudflareDeployments,
  deno: listDenoDeployments,
  netlify: listNetlifyDeployments,
  vercel: listVercelDeployments,
}

/** How long `vitehub deployments` waits for the host. */
const DEPLOYMENTS_TIMEOUT_MS = 30_000

/** How long `vitehub status` waits for the host before it reports `liveReason: "timeout"`. */
export const STATUS_HOST_TIMEOUT_MS = 5_000

/** What `vitehub deployments --json` prints, after `schemaVersion: 1`. */
export interface SetupDeploymentsOutput {
  host: SetupLinkHost
  project: SetupLink["project"]
  deployments: HostDeployment[]
}

/** The deployment that receives production traffic, as `vitehub status` reports it. */
export interface SetupLive {
  deploymentId: string
  url?: string
  commit?: DeployCommit
  /** Commits on HEAD that the live deployment does not have. */
  behind?: number
  /** Commits in the live deployment that HEAD does not have. */
  ahead?: number
  /** Why `behind` and `ahead` are not known. */
  unknownReason?: "commit-not-local" | "no-marker" | "no-git"
}

/** Why `live` is `null`. */
export type SetupLiveReason = "offline" | "not-linked" | "no-credentials" | "no-live-deployment" | "timeout" | "host-error"

export interface SetupLiveStatus {
  live: SetupLive | null
  liveReason: SetupLiveReason | null
}

/** A fetch that gives up after `ms`, so a slow host cannot hold the command. */
function fetchWithTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return async (input, init) => await fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) })
}

function deploymentsContext(root: string, link: SetupLink, credentials: Extract<HostCredentials, { ok: true }>, context: ViteHubCliContext, run: DeployRun, timeoutMs: number): DeploymentsContext {
  return { credentials, env: context.env, fetch: fetchWithTimeout(context.fetch ?? globalThis.fetch, timeoutMs), link, root, run, timeoutMs }
}

function readLimit(value: string | undefined): number {
  if (value === undefined) return 10
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] --limit must be a whole number from 1 to 100, not ${JSON.stringify(value)}. Usage: ${usage}` })
  return limit
}

function readDeploymentsArgs(args: readonly string[]) {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        help: { short: "h", type: "boolean", default: false },
        json: { type: "boolean", default: false },
        limit: { type: "string" },
      },
      strict: true,
    })
    return { help: values.help, json: values.json, limit: readLimit(values.limit) }
  }
  catch (error: unknown) {
    if (error instanceof Error && "why" in error) throw error
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${usage}` })
  }
}

function shortCommit(commit: HostDeployment["commit"]): string {
  return commit ? `${commit.sha.slice(0, 7)}${commit.dirty ? " (dirty)" : ""}` : "-"
}

function writeDeployments(output: SetupDeploymentsOutput, context: ViteHubCliContext): void {
  if (!output.deployments.length) {
    context.stdout.write(`${output.project.name} on ${output.host} has no deployments.\n`)
    return
  }
  context.stdout.write(`${table([
    ["", "id", "target", "state", "commit", "created", "url"],
    ...output.deployments.map(item => [item.live ? "live" : "", item.id, item.target, item.state, shortCommit(item.commit), item.createdAt, item.url ?? "-"]),
  ])}\n`)
}

async function runDeployments(limit: number, json: boolean, context: ViteHubCliContext): Promise<number> {
  const project = await readSetupProject(context.rootDir, context.env)
  const link = await readSetupLink(project.root)
  if (!link) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_NOT_LINKED(), setupExitCodes.inputNeeded, { missing: [{ field: "link" }], rerun: "vitehub link" })
  const credentials = await resolveHostCredentials(link.host, { cwd: project.root, env: context.env, ...(context.runHostCli ? { run: context.runHostCli } : {}) })
  if (!credentials.ok) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_CREDENTIALS_MISSING({ fix: credentials.fix, host: link.host }), setupExitCodes.inputNeeded, {
      missing: credentials.missing.map(field => ({ field })),
    })
  }
  const run = createDeployRun(context.stderr, [])
  const deployments = await listers[link.host](deploymentsContext(project.root, link, credentials, context, run, DEPLOYMENTS_TIMEOUT_MS), { limit })
  const output: SetupDeploymentsOutput = { deployments, host: link.host, project: link.project }
  if (json) writeSetupJson(context, output)
  else writeDeployments(output, context)
  return setupExitCodes.done
}

export const deploymentsCommand: ViteHubCliCommand = {
  description: "List the deployments of the linked project, read from the host each time. Marks the one that receives production traffic.",
  name: "deployments",
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const parsed = readDeploymentsArgs(args)
      if (parsed.help) {
        context.stdout.write(`Usage: ${usage}\n\n${deploymentsCommand.description}\n`)
        return setupExitCodes.done
      }
      return await runDeployments(parsed.limit, parsed.json, context)
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
  usage,
}

/**
 * Compares the live commit with HEAD: `git rev-list --left-right --count <sha>...HEAD` prints the commits that only
 * the deployment has, then the commits that only HEAD has.
 */
async function compareWithHead(run: DeployRun, root: string, env: NodeJS.ProcessEnv, sha: string): Promise<Pick<SetupLive, "ahead" | "behind" | "unknownReason">> {
  const git = async (args: readonly string[]) => {
    try {
      return await run("git", args, { cwd: root, env, timeoutMs: STATUS_HOST_TIMEOUT_MS })
    }
    catch {
      return undefined
    }
  }
  const inside = await git(["rev-parse", "--is-inside-work-tree"])
  if (inside?.exitCode !== 0 || inside.stdout.trim() !== "true") return { unknownReason: "no-git" }
  const known = await git(["cat-file", "-e", `${sha}^{commit}`])
  if (known?.exitCode !== 0) return { unknownReason: "commit-not-local" }
  const counts = await git(["rev-list", "--left-right", "--count", `${sha}...HEAD`])
  const match = counts?.exitCode === 0 ? /^(\d+)\s+(\d+)/u.exec(counts.stdout.trim()) : undefined
  if (!match) return { unknownReason: "no-git" }
  return { ahead: Number(match[1]), behind: Number(match[2]) }
}

function isTimeout(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true
  return error instanceof Error && error.cause instanceof Error && isTimeout(error.cause)
}

/**
 * The deployment that receives production traffic, for `vitehub status`. It asks the host only when the project is
 * linked and the credentials resolved, and gives up after `STATUS_HOST_TIMEOUT_MS`. It never throws: a failure is a
 * `liveReason`.
 */
export async function readSetupLive(root: string, link: SetupLink | undefined, credentials: HostCredentials | undefined, context: ViteHubCliContext, options: { offline: boolean }): Promise<SetupLiveStatus> {
  if (options.offline) return { live: null, liveReason: "offline" }
  if (!link) return { live: null, liveReason: "not-linked" }
  if (!credentials?.ok || credentials.host !== link.host) return { live: null, liveReason: "no-credentials" }
  const run = createDeployRun(context.stderr, [])
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(resolve, STATUS_HOST_TIMEOUT_MS + 1_000, "timeout")
    timer.unref()
  })
  try {
    // Ten deployments, so a live deployment behind a few newer previews is still found.
    const listed = await Promise.race([listers[link.host](deploymentsContext(root, link, credentials, context, run, STATUS_HOST_TIMEOUT_MS), { limit: 10 }), deadline])
    if (listed === "timeout") return { live: null, liveReason: "timeout" }
    const deployment = listed.find(item => item.live)
    if (!deployment) return { live: null, liveReason: "no-live-deployment" }
    const base = { deploymentId: deployment.id, ...(deployment.url ? { url: deployment.url } : {}) }
    if (!deployment.commit) return { live: { ...base, unknownReason: "no-marker" }, liveReason: null }
    const commit = { dirty: deployment.commit.dirty, sha: deployment.commit.sha }
    return { live: { ...base, commit, ...await compareWithHead(run, root, context.env, commit.sha) }, liveReason: null }
  }
  catch (error: unknown) {
    return { live: null, liveReason: isTimeout(error) ? "timeout" : "host-error" }
  }
  finally {
    clearTimeout(timer)
  }
}

const reasonLabels: Record<SetupLiveReason, string> = {
  "host-error": "unknown (the host request failed; run `vitehub deployments` for the error)",
  "no-credentials": "unknown (no host credentials)",
  "no-live-deployment": "none (nothing receives production traffic)",
  "not-linked": "unknown (not linked)",
  "offline": "not checked (--offline)",
  "timeout": "unknown (the host did not answer in time)",
}

const unknownLabels: Record<NonNullable<SetupLive["unknownReason"]>, string> = {
  "commit-not-local": "commit not in this repository",
  "no-git": "no git repository",
  "no-marker": "no commit marker",
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/** The `live` line of `vitehub status`, such as `abc1234 (3 commits behind)`. */
export function liveLabel(status: SetupLiveStatus): string {
  const { live } = status
  if (!live) return reasonLabels[status.liveReason ?? "no-live-deployment"]
  const name = live.commit ? live.commit.sha.slice(0, 7) : live.deploymentId
  const notes: string[] = []
  if (live.unknownReason) notes.push(unknownLabels[live.unknownReason])
  else if (live.ahead || live.behind) notes.push([live.behind ? `${plural(live.behind, "commit")} behind` : "", live.ahead ? `${plural(live.ahead, "commit")} ahead` : ""].filter(Boolean).join(", "))
  else notes.push("up to date")
  if (live.commit?.dirty) notes.push("with uncommitted changes")
  return `${name} (${notes.join(", ")})${live.url ? ` ${live.url}` : ""}`
}
