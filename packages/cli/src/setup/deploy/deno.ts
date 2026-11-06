import { readFile } from "node:fs/promises"
import process from "node:process"

import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { findUrl, hostCli, hostCliFailed, isoTime, isRecord, lastJsonObject, listsName, optionalString } from "./host.ts"

import type { SetupLink } from "../link.ts"
import type { DeployAdapter, DeployContext, HostDeployment, ListDeployments } from "./host.ts"

/** The first line of the `deploy.mjs` that ViteHub's Deno build writes (`packages/internal/src/build/deno-runtime-packages.ts`). */
const runnerFirstLine = "import { spawn } from \"node:child_process\""

/** `deno deploy` exits with 4 when the app does not exist. */
const notFoundExitCode = 4

// Deno Deploy CLI 0.0.9909 (`deno deploy --help`, `deno deploy env --help`), recorded in test/fixtures/host-cli-help/.
// The CLI reads DENO_DEPLOY_TOKEN from the environment. `env add` takes the value as an argument, but `env load` reads
// a dotenv file, so the secret goes through `/dev/stdin`.
export async function denoAdapter(context: DeployContext, organization: string): Promise<DeployAdapter> {
  const runner = join(context.outputDir, "deploy.mjs")
  const source = await readFile(runner, "utf8").catch(() => undefined)
  if (source === undefined) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: runner }), setupExitCodes.error)
  if (!source.startsWith(runnerFirstLine)) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_COMMAND_REJECTED({ command: runner }), setupExitCodes.error)
  const deno = hostCli("deno", "deno", context.root, context.env)
  const app = ["--org", organization, "--app", context.projectName]
  const env = { ...context.env, DENO_DEPLOY_APP: context.projectName, DENO_DEPLOY_ORG: organization }
  const runDeno = (args: readonly string[], stdin?: string) =>
    context.run(deno[0], [...deno.slice(1), "deploy", ...args, "--json", "--non-interactive", ...app], { cwd: context.root, env, ...(stdin === undefined ? {} : { stdin }) })

  return {
    async deploy() {
      // The runner copies the output to a temp folder and runs `deno deploy create` or `deno deploy --prod`.
      const result = await context.run(process.execPath, [runner], { cwd: context.root, env, show: true })
      if (result.exitCode !== 0) throw hostCliFailed("node .output/deploy.mjs", result, context.secrets)
      const url = findUrl(`${result.stdout}\n${result.stderr}`, /\.deno\.(?:net|dev)$/u)
      if (!url) throw hostCliFailed("deno deploy printed no URL", result, context.secrets)
      return { url, project: { name: context.projectName, accountId: organization } }
    },
    async setSecret(name, value) {
      if (process.platform === "win32") throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_SECRET_UNSUPPORTED({ host: "deno", reason: "Windows has no /dev/stdin for `deno deploy env load`." }), setupExitCodes.conflict)
      const result = await runDeno(["env", "load", "/dev/stdin", "--replace"], `${name}=${value}\n`)
      if (result.exitCode !== 0) throw hostCliFailed(`deno deploy env load (${name})`, result, context.secrets)
    },
    async hasSecret(name) {
      const result = await runDeno(["env", "list"])
      return result.exitCode === 0 && listsName(safeJson(result.stdout) ?? lastJsonObject(result.stdout), ["key"], name)
    },
    async projectExists() {
      const result = await runDeno(["env", "list"])
      if (result.exitCode === 0) return true
      if (result.exitCode === notFoundExitCode) return false
      throw hostCliFailed("deno deploy env list", result, context.secrets)
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** The Deno Deploy organization: `DENO_DEPLOY_ORG`, else the account of a Deno link. */
export function denoOrganization(link: SetupLink | undefined, env: NodeJS.ProcessEnv): string {
  const organization = env.DENO_DEPLOY_ORG?.trim() || (link?.host === "deno" ? link.account?.id : undefined)
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
export const listDenoDeployments: ListDeployments = async (context, { limit }) => {
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
  return items.flatMap((item: unknown) => {
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
}
