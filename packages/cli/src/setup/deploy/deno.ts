import { readFile } from "node:fs/promises"
import process from "node:process"

import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { findUrl, hostCli, hostCliFailed, lastJsonObject, listsName } from "./host.ts"

import type { DeployAdapter, DeployContext } from "./host.ts"

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
