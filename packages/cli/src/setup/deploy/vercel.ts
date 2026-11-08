import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"

import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { createDeployRun, hostCli, hostCliFailed, isRecord, lastJsonObject, listsName, optionalString, withTemporaryOutput } from "./host.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { DeployAdapter, DeployContext, DeployResult } from "./host.ts"

/** Check the CLI's saved session without reading its auth files or exposing a token. */
export async function hasVercelLogin(root: string, context: ViteHubCliContext): Promise<boolean> {
  try {
    const [command, ...args] = hostCli("vercel", "vercel", root, context.env)
    const run = context.runHostCli ?? createDeployRun(context.stderr, [])
    const result = await run(command, [...args, "whoami"], { cwd: root, env: context.env })
    return result.exitCode === 0
  }
  catch {
    return false
  }
}

/** Every `.vc-config.json` of a Vercel Build Output API function. */
async function functionConfigs(folder: string): Promise<string[]> {
  if (!existsSync(folder)) return []
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile() && entry.name === ".vc-config.json").map(entry => join(entry.parentPath, entry.name))
}

/** Reads `claimUrl` and `expiresAt` that `vercel deploy --temporary` keeps in `.vercel/anonymous.json`. Its token stays there. */
async function readClaim(root: string): Promise<DeployResult["claim"]> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(root, ".vercel", "anonymous.json"), "utf8"))
  }
  catch {
    return
  }
  const url = isRecord(value) ? optionalString(value.claimUrl) : undefined
  if (!url || !isRecord(value)) return
  return { url, ...(typeof value.expiresAt === "number" ? { expiresAt: new Date(value.expiresAt).toISOString() } : {}) }
}

// Vercel CLI 65.11: `vercel deploy --help`, `vercel env add --help`, `vercel env ls --help`. Recorded in
// test/fixtures/host-cli-help/. The CLI reads VERCEL_TOKEN from the environment, so no token goes in argv.
export function vercelAdapter(context: DeployContext): DeployAdapter {
  const vercel = hostCli("vercel", "vercel", context.root, context.env)
  const credentialTeam = context.credentials.ok ? context.credentials.teamId : optionalString(context.env.VERCEL_TEAM_ID?.trim()) ?? optionalString(context.env.VERCEL_ORG_ID?.trim())
  const team = (context.link?.host === "vercel" ? context.link.account?.id : undefined) ?? credentialTeam
  const project = context.link?.host === "vercel" ? context.link.project.id ?? context.projectName : context.projectName
  const target = context.temporary ? [] : ["--project", project, ...(team ? ["--scope", team] : [])]
  const environment = context.preview ? "preview" : "production"
  const run = (args: readonly string[], options: { stdin?: string, show?: boolean } = {}) =>
    context.run(vercel[0], [...vercel.slice(1), ...args], { cwd: context.root, env: context.env, ...options })

  return {
    async deploy() {
      const args = ["deploy", "--prebuilt", "--yes", "--json", ...(context.preview ? [] : ["--prod"])]
      if (context.temporary) args.push("--temporary")
      else args.push(...target, "--create-if-missing")
      if (context.commit) args.push("--meta", `vitehubCommit=${context.commit.sha}`, "--meta", `vitehubDirty=${context.commit.dirty}`)
      const result = await run(args, { show: true })
      if (result.exitCode !== 0) throw hostCliFailed("vercel deploy", result, context.secrets)
      // Without a terminal the CLI wraps the deployment in `{ status, deployment }`.
      const json = lastJsonObject(result.stdout)
      const deployment = isRecord(json?.deployment) ? json.deployment : json
      const url = context.preview ? optionalString(deployment?.url) : optionalString(deployment?.productionUrl) ?? optionalString(deployment?.url)
      if (!url) throw hostCliFailed("vercel deploy printed no URL", result, context.secrets)
      const id = optionalString(deployment?.id)
      const claim = context.temporary ? await readClaim(context.root) : undefined
      return { url, ...(id ? { deploymentId: id } : {}), ...(claim ? { claim } : {}), ...(context.temporary ? {} : { project: { name: context.projectName, ...(team ? { accountId: team } : {}) } }) }
    },
    async setSecret(name, value) {
      // `vercel env add` reads the value from stdin. `--force` replaces the value of an earlier deploy.
      const result = await run(["env", "add", name, "--environment", environment, "--sensitive", "--force", "--yes", ...target], { stdin: value })
      if (result.exitCode !== 0) throw hostCliFailed(`vercel env add ${name}`, result, context.secrets)
    },
    async hasSecret(name) {
      const result = await run(["env", "ls", "--environment", environment, "--json", ...target])
      if (result.exitCode !== 0) return false
      return listsName(lastJsonObject(result.stdout), ["key"], name)
    },
    // `vitehub link` confirmed the project through the Vercel API. Else the first deploy creates it.
    projectExists: async () => context.link?.host === "vercel" && context.link.verified,
    async withTemporaryVar(name, value, deploy) {
      // A temporary deploy has no project to hold an env var. The Build Output API reads `environment` from each
      // function's `.vc-config.json`, so the hash goes there as a plain var. The project files do not change.
      const files = await functionConfigs(join(context.outputDir, "functions"))
      if (!files.length) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: join(context.outputDir, "functions/**/.vc-config.json") }), setupExitCodes.error)
      return await withTemporaryOutput(files, "environment", name, value, deploy)
    },
  }
}
