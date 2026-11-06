import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { join, resolve } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { commandRejected, commitMessage, findUrl, hostCli, hostCliFailed, isRecord, listsName, optionalString, splitManifestCommand } from "./host.ts"

import type { DeployAdapter, DeployContext, DeployResult } from "./host.ts"

/** The flags that ViteHub's own build writes into `commands.deploy` (`packages/vite-hub/src/index.ts`). */
const valueFlags = new Set(["--config", "--secrets-file"])
const plainFlags = new Set(["--containers-rollout=gradual"])

interface WranglerCommand {
  /** `--config` and `--secrets-file` with their values, and the rollout flag, in build order. */
  args: string[]
  config: string
}

/**
 * Reads `commands.deploy` from `<output>/nitro.json` and checks that it is the Wrangler deploy that the build writes:
 * `npx wrangler deploy --config <file> [--secrets-file <file>] [--containers-rollout=gradual]`.
 */
async function readWranglerCommand(outputDir: string): Promise<WranglerCommand> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(outputDir, "nitro.json"), "utf8"))
  }
  catch {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: join(outputDir, "nitro.json") }), setupExitCodes.error)
  }
  const command = isRecord(manifest) && isRecord(manifest.commands) ? optionalString(manifest.commands.deploy) : undefined
  if (!command) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: `commands.deploy in ${join(outputDir, "nitro.json")}` }), setupExitCodes.error)
  const words = splitManifestCommand(command)
  if (words[0] !== "npx" || words[1] !== "wrangler" || words[2] !== "deploy") throw commandRejected(command)
  const args: string[] = []
  let config: string | undefined
  for (let index = 3; index < words.length; index++) {
    const word = words[index]!
    if (plainFlags.has(word)) args.push(word)
    else if (valueFlags.has(word) && words[index + 1] !== undefined && !words[index + 1]!.startsWith("-")) {
      const value = words[++index]!
      if (word === "--config") config = value
      args.push(word, value)
    }
    else throw commandRejected(command)
  }
  if (!config) throw commandRejected(command)
  return { args, config }
}

interface WranglerOutputEntry {
  type?: unknown
  version_id?: unknown
  targets?: unknown
  preview_url?: unknown
  worker_name?: unknown
}

/** Wrangler writes one JSON object per line to `WRANGLER_OUTPUT_FILE_PATH`. */
async function readWranglerOutput(file: string): Promise<WranglerOutputEntry[]> {
  const text = await readFile(file, "utf8").catch(() => "")
  return text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return isRecord(value) ? [value] : []
    }
    catch {
      return []
    }
  })
}

const durationUnits: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }

/** `Claim within: 59 minutes` as an ISO time, from now. */
function claimExpiry(text: string): string | undefined {
  const match = /Claim within:\s*(\d+)\s*(second|minute|hour|day)s?/u.exec(text)
  return match ? new Date(Date.now() + Number(match[1]) * durationUnits[match[2]!]!).toISOString() : undefined
}

// Wrangler 4.158: `wrangler deploy --help`, `wrangler secret put --help`, `wrangler secret list --help`, and the global
// `--temporary` flag. Recorded in test/fixtures/host-cli-help/.
export async function cloudflareAdapter(context: DeployContext): Promise<DeployAdapter> {
  const command = await readWranglerCommand(context.outputDir)
  const wrangler = hostCli("wrangler", "wrangler", context.root, context.env)
  const env: NodeJS.ProcessEnv = {
    ...context.env,
    ...(context.credentials.ok && context.credentials.accountId ? { CLOUDFLARE_ACCOUNT_ID: context.credentials.accountId } : {}),
  }
  const run = (args: readonly string[], options: { stdin?: string, show?: boolean, env?: NodeJS.ProcessEnv } = {}) =>
    context.run(wrangler[0], [...wrangler.slice(1), ...args], { cwd: context.outputDir, env: options.env ?? env, ...options })

  return {
    async deploy(): Promise<DeployResult> {
      const folder = await mkdtemp(join(tmpdir(), "vitehub-deploy-"))
      const outputFile = join(folder, "wrangler-output.jsonl")
      try {
        const args = context.preview
          ? ["versions", "upload", ...command.args.filter(arg => !plainFlags.has(arg))]
          : ["deploy", ...command.args]
        if (context.temporary) args.push("--temporary")
        if (context.commit) args.push("--tag", context.commit.sha.slice(0, 12), "--message", commitMessage(context.commit))
        const result = await run(args, { env: { ...env, WRANGLER_OUTPUT_FILE_PATH: outputFile }, show: true })
        if (result.exitCode !== 0) throw hostCliFailed(context.preview ? "wrangler versions upload" : "wrangler deploy", result, context.secrets)
        const entry = (await readWranglerOutput(outputFile)).findLast(item => item.type === (context.preview ? "version-upload" : "deploy"))
        const text = `${result.stdout}\n${result.stderr}`
        const targets = Array.isArray(entry?.targets) ? entry.targets.filter(target => typeof target === "string") : []
        const url = (context.preview ? optionalString(entry?.preview_url) : targets[0]) ?? findUrl(text, /\.workers\.dev$/u)
        if (!url) throw hostCliFailed("wrangler deploy printed no URL", result, context.secrets)
        const version = optionalString(entry?.version_id)
        const claimUrl = /Claim URL:\s*(https:\/\/\S+)/u.exec(text)?.[1]
        const expiresAt = claimExpiry(text)
        const name = optionalString(entry?.worker_name)
        return {
          url,
          ...(version ? { version } : {}),
          ...(claimUrl ? { claim: { url: claimUrl, ...(expiresAt ? { expiresAt } : {}) } } : {}),
          ...(name ? { project: { name, ...(context.credentials.ok && context.credentials.accountId ? { accountId: context.credentials.accountId } : {}) } } : {}),
        }
      }
      finally {
        await rm(folder, { force: true, recursive: true })
      }
    },
    async setSecret(name, value) {
      // `wrangler secret put` reads the value from stdin when stdin is not a terminal. On a Worker that does not
      // exist yet, it creates a draft Worker without a prompt.
      const result = await run(["secret", "put", name, "--config", command.config], { stdin: value })
      if (result.exitCode !== 0) throw hostCliFailed(`wrangler secret put ${name}`, result, context.secrets)
    },
    async hasSecret(name) {
      const result = await run(["secret", "list", "--config", command.config, "--format", "json"])
      if (result.exitCode !== 0) return false
      try {
        return listsName(JSON.parse(result.stdout), ["name"], name)
      }
      catch {
        return false
      }
    },
    // `wrangler secret put` creates a draft Worker, so the secret can go first.
    projectExists: async () => true,
    async setTemporaryVar(name, value) {
      // A temporary account has no login for `wrangler secret put`, so the hash goes into the generated config as a
      // plain var. The project config does not change.
      const file = resolve(context.outputDir, command.config)
      const config: unknown = JSON.parse(await readFile(file, "utf8"))
      if (!isRecord(config)) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file }), setupExitCodes.error)
      config.vars = { ...(isRecord(config.vars) ? config.vars : {}), [name]: value }
      await writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
    },
  }
}
