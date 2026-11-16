import { readFile } from "node:fs/promises"
import process from "node:process"

import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { setupFailure, setupExitCodes } from "../envelope.ts"
import { findUrl, hostCli, hostCliFailed, hostListFailed, isoTime, isRecord, lastJsonObject, optionalString } from "./host.ts"

import type { SetupLink } from "../link.ts"
import type { DeployAdapter, DeployContext, HostDeployment, HostEnv, HostEnvContext, ListDeployments } from "./host.ts"

/** The first line of the `deploy.mjs` that ViteHub's Deno build writes (`packages/internal/src/build/deno-runtime-packages.ts`). */
const runnerFirstLine = "import { spawn } from \"node:child_process\""

// Deno Deploy CLI 0.0.9909 (`deno deploy --help`), recorded in test/fixtures/host-cli-help/. The CLI reads
// DENO_DEPLOY_TOKEN from the environment.
export async function denoAdapter(context: DeployContext, organization: string): Promise<DeployAdapter> {
  const runner = join(context.outputDir, "deploy.mjs")
  const source = await readFile(runner, "utf8").catch(() => undefined)
  if (source === undefined) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: runner }), setupExitCodes.error)
  if (!source.startsWith(runnerFirstLine)) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_COMMAND_REJECTED({ command: runner }), setupExitCodes.error)
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
  if (!organization) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_ORG_REQUIRED(), setupExitCodes.inputNeeded, { missing: [{ field: "DENO_DEPLOY_ORG" }] })
  return organization
}

/**
 * One `KEY='value'` line for `deno deploy env load`, which parses the file with `@std/dotenv`. A single-quoted value
 * is taken as it is. A value with a quote or a line break has no safe dotenv form, so it is refused.
 */
function dotenvLine(name: string, value: string): string {
  if (/['\r\n]/u.test(value)) throw setupFailure(cliErrorDiagnostics.SETUP_ENV_VALUE_UNSUPPORTED({ host: "deno", name, reason: "It has a single quote or a line break, and `deno deploy env load` reads a dotenv file." }), setupExitCodes.conflict)
  return `${name}='${value}'\n`
}

/**
 * The environment variables of the linked app. Deno Deploy CLI 0.0.9909 (`deno deploy env list --help`, `deno deploy env
 * load --help`, in test/fixtures/host-cli-help/). `env add` takes the value as an argument, so the value goes to
 * `env load /dev/stdin` as a dotenv line. `env load` sets a variable for every context, and Deno decides from the name
 * whether it is secret; names it cannot store as secrets are refused. `--non-secrets` keeps a plain value readable.
 * ViteHub deploys Deno to production only.
 */
export function denoEnv(context: HostEnvContext): HostEnv {
  const deno = hostCli("deno", "deno", context.root, context.env)
  const app = ["--org", denoOrganization(context.link, context.env), "--app", context.link.project.name]
  const run = (args: readonly string[], stdin?: string) =>
    context.run(deno[0], [...deno.slice(1), "deploy", "env", ...args, "--json", "--non-interactive", ...app], { cwd: context.root, env: context.env, ...(stdin === undefined ? {} : { stdin, stdinAsFile: true }) })

  return {
    async listSecretNames() {
      const result = await run(["list"])
      if (result.exitCode !== 0) throw hostListFailed("deno deploy env list", result, context.secrets)
      const start = result.stdout.indexOf("[")
      let value: unknown
      try {
        value = JSON.parse(result.stdout.slice(start))
      }
      catch {
        throw hostListFailed("deno deploy env list printed no JSON", result, context.secrets)
      }
      return Array.isArray(value) ? value.flatMap(item => isRecord(item) && typeof item.key === "string" ? [item.key] : []) : []
    },
    async setSecret(name, value, { secret }) {
      if (process.platform === "win32") throw setupFailure(cliErrorDiagnostics.SETUP_ENV_VALUE_UNSUPPORTED({ host: "deno", name, reason: "Windows has no /dev/stdin for `deno deploy env load`." }), setupExitCodes.conflict)
      // env load infers secrecy from the key; accept only known secret suffixes without a public prefix.
      // Omitting --non-secrets cannot force a name such as DATABASE_URL to stay secret.
      if (secret && (!/_(?:KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIALS|AUTH)$/u.test(name) || /^(?:PUBLIC|VITE|NEXT_PUBLIC|NUXT_PUBLIC|REACT_APP|EXPO_PUBLIC|GATSBY)_/u.test(name))) throw setupFailure(cliErrorDiagnostics.SETUP_ENV_VALUE_UNSUPPORTED({ host: "deno", name, reason: "The Deno CLI cannot enforce secret storage for this name. Set it as a secret in Deno Deploy before continuing." }), setupExitCodes.conflict)
      const result = await run(["load", "/dev/stdin", "--replace", ...(secret ? [] : ["--non-secrets", name])], dotenvLine(name, value))
      if (result.exitCode !== 0) throw hostCliFailed(`deno deploy env load (${name})`, result, context.secrets)
    },
  }
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
