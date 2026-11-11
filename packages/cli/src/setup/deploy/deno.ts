import { readFile } from "node:fs/promises"
import process from "node:process"

import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { findUrl, hostCli, hostCliFailed, isoTime, isRecord, lastJsonObject, optionalString } from "./host.ts"

import type { SetupLink } from "../link.ts"
import type { DeployAdapter, DeployContext, HostDeployment, ListDeployments } from "./host.ts"

/** The first line of the `deploy.mjs` that ViteHub's Deno build writes (`packages/internal/src/build/deno-runtime-packages.ts`). */
const runnerFirstLine = "import { spawn } from \"node:child_process\""

// Deno Deploy CLI 0.0.9909 (`deno deploy --help`), recorded in test/fixtures/host-cli-help/. The CLI reads
// DENO_DEPLOY_TOKEN from the environment.
export async function denoAdapter(context: DeployContext, organization: string): Promise<DeployAdapter> {
  const runner = join(context.outputDir, "deploy.mjs")
  const source = await readFile(runner, "utf8").catch(() => undefined)
  if (source === undefined) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: runner }), setupExitCodes.error)
  if (!source.startsWith(runnerFirstLine)) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_COMMAND_REJECTED({ command: runner }), setupExitCodes.error)
  const env = { ...context.env, DENO_DEPLOY_APP: context.projectName, DENO_DEPLOY_ORG: organization }

  return {
    async deploy() {
      // The runner copies the output to a temp folder and runs `deno deploy create` or `deno deploy --prod`.
      const result = await context.run(process.execPath, [runner], { cwd: context.root, env, show: true })
      if (result.exitCode !== 0) throw hostCliFailed("node .output/deploy.mjs", result, context.secrets)
      const url = findUrl(`${result.stdout}\n${result.stderr}`, /\.deno\.(?:net|dev)$/u)
      if (!url) throw hostCliFailed("deno deploy printed no URL", result, context.secrets)
      return { url, project: { name: context.projectName, accountId: organization } }
    },
  }
}

/** The Deno Deploy organization: the linked account, else `DENO_DEPLOY_ORG`. */
export function denoOrganization(link: SetupLink | undefined, env: NodeJS.ProcessEnv): string {
  const organization = (link?.host === "deno" ? link.account?.id : undefined) ?? env.DENO_DEPLOY_ORG?.trim()
  if (!organization) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ORG_REQUIRED(), setupExitCodes.inputNeeded, { missing: [{ field: "DENO_DEPLOY_ORG" }] })
  return organization
}

function denoState(value: unknown): HostDeployment["state"] {
  if (value === "succeeded") return "ready"
  if (value === "failed") return "error"
  if (value === "skipped") return "canceled"
  return value === "queued" || value === "building" ? "building" : "unknown"
}

/**
 * Deno Deploy CLI 0.0.9909, recorded in test/fixtures/host-cli-help/. Both print one JSON object with `--json`:
 * - `deno deploy deployments list --limit <n>`: `{ items: [{ id, status, prod, createdAt }] }`, newest first.
 * - `deno deploy apps get`: `productionRevisionId` and `productionUrl`, the revision that serves production.
 * Deno Deploy keeps no deploy message, so a Deno deployment has no commit.
 * https://docs.deno.com/runtime/reference/cli/deploy/#agent--ci-usage
 */
export const listDenoDeployments: ListDeployments = async (context, { limit, includeLive }) => {
  const organization = denoOrganization(context.link, context.env)
  const deno = hostCli("deno", "deno", context.root, context.env)
  const app = ["--json", "--non-interactive", "--org", organization, "--app", context.link.project.name]
  const run = async (step: string, args: readonly string[]) => {
    const result = await context.run(deno[0], [...deno.slice(1), "deploy", ...args, ...app], { cwd: context.root, env: context.env, ...(context.timeoutMs ? { timeoutMs: context.timeoutMs } : {}) })
    if (result.exitCode !== 0) throw hostCliFailed(step, result, [])
    return lastJsonObject(result.stdout)
  }
  const [list, details] = await Promise.all([
    run("deno deploy deployments list", ["deployments", "list", "--limit", String(limit)]),
    run("deno deploy apps get", ["apps", "get"]),
  ])
  const production = optionalString(details?.productionRevisionId)
  const productionUrl = optionalString(details?.productionUrl)
  const items = Array.isArray(list?.items) ? list.items : []
  const recent = items.flatMap((item: unknown) => {
    const id = isRecord(item) ? optionalString(item.id) : undefined
    if (!id || !isRecord(item)) return []
    const live = id === production
    return [{
      createdAt: isoTime(item.createdAt),
      id,
      live,
      source: "unknown",
      state: denoState(item.status),
      target: item.prod === true ? "production" : "preview",
      ...(live && productionUrl ? { url: productionUrl } : {}),
    } satisfies HostDeployment]
  }).slice(0, limit)
  // The app's authoritative pointer suffices for status; Deno has no commit marker to fetch.
  if (includeLive && production && !recent.some(item => item.live)) {
    recent.push({ createdAt: "", id: production, live: true, source: "unknown", state: "ready", target: "production", ...(productionUrl ? { url: productionUrl } : {}) })
  }
  return recent
}
