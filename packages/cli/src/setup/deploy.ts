import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"

import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { resolveHostCredentials } from "@vite-hub/internal/host-credentials"
import { basename, join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { cloudflareAdapter } from "./deploy/cloudflare.ts"
import { denoAdapter, denoOrganization } from "./deploy/deno.ts"
import { createDeployRun, isRecord, optionalString, readDeployCommit } from "./deploy/host.ts"
import { netlifyAdapter } from "./deploy/netlify.ts"
import { vercelAdapter } from "./deploy/vercel.ts"
import { SetupFailure, setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { ensureViteHubGitignore, readSetupConsoleLink, readSetupLink, writeSetupLinkFile } from "./link.ts"
import { readSetupProject } from "./project.ts"
import { setupStatus } from "./status.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { HostCredentials } from "@vite-hub/internal/host-credentials"
import type { DeployAdapter, DeployCommit, DeployContext, DeployHost, DeployResult } from "./deploy/host.ts"
import type { SetupConsoleLink, SetupLink } from "./link.ts"
import type { SetupProject } from "./project.ts"

/** The host variable that holds the SHA-256 of the Console token. The app compares a bearer token's hash with it. */
export const CONSOLE_TOKEN_VARIABLE = "VITEHUB_CONSOLE_TOKEN_SHA256"

/** The Console page that finishes a pending link. Nothing in its URL is secret. */
const consoleLinkPage = "https://console.vitehub.dev/link"

const deployHosts: readonly DeployHost[] = ["cloudflare", "vercel", "netlify", "deno"]
const temporaryHosts: readonly DeployHost[] = ["cloudflare", "vercel"]

const usage = "vitehub deploy [--preview] [--no-build] [--temporary] [--yes] [--json]"

export interface SetupDeployArgs {
  preview: boolean
  build: boolean
  temporary: boolean
  yes: boolean
  json: boolean
  help: boolean
}

/** What `vitehub deploy --json` prints, after `schemaVersion: 1`. */
export interface SetupDeployOutput {
  host: DeployHost
  url: string
  deploymentId?: string
  version?: string
  temporary?: { claimUrl: string, expiresAt?: string }
  console?: { linkUrl: string, secret: "set" | "var" }
  commit?: DeployCommit
}

export function readDeployArgs(args: readonly string[]): SetupDeployArgs {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        "help": { short: "h", type: "boolean", default: false },
        "json": { type: "boolean", default: false },
        "no-build": { type: "boolean", default: false },
        "preview": { type: "boolean", default: false },
        "temporary": { type: "boolean", default: false },
        "yes": { short: "y", type: "boolean", default: false },
      },
      strict: true,
    })
    return { build: !values["no-build"], help: values.help, json: values.json, preview: values.preview, temporary: values.temporary, yes: values.yes }
  }
  catch (error: unknown) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${usage}` })
  }
}

function rerunCommand(args: SetupDeployArgs, extra: { temporary?: boolean } = {}): string {
  return ["vitehub deploy", ...(args.preview ? ["--preview"] : []), ...(args.build ? [] : ["--no-build"]), ...(args.temporary || extra.temporary ? ["--temporary"] : []), "--yes", ...(args.json ? ["--json"] : [])].join(" ")
}

function deployHost(project: SetupProject, link: SetupLink | undefined, env: NodeJS.ProcessEnv): DeployHost {
  const host = link?.host ?? setupStatus(project, env).host.name
  const found = deployHosts.find(item => item === host)
  if (!found) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_HOST_UNSUPPORTED({ host }), setupExitCodes.conflict)
  return found
}

function temporaryUnsupported(reason: string): SetupFailure {
  return new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_TEMPORARY_UNSUPPORTED({ reason }), setupExitCodes.conflict)
}

/** Cloudflare: Wrangler refuses `--temporary` with a login. Vercel: the CLI refuses it in CI and in a linked folder. */
function assertTemporary(host: DeployHost, args: SetupDeployArgs, credentials: HostCredentials, project: SetupProject, env: NodeJS.ProcessEnv): void {
  if (!temporaryHosts.includes(host)) throw temporaryUnsupported(`${host} has no temporary deploy. Only cloudflare and vercel have one.`)
  if (args.preview) throw temporaryUnsupported("A temporary deploy always goes to production, so --preview does not apply.")
  if (credentials.ok) throw temporaryUnsupported(`It is for a machine without a ${host} login, and credentials were found (${credentials.source}).`)
  if (host === "vercel") {
    if (env.CI && env.CI !== "0" && env.CI !== "false") throw temporaryUnsupported("The Vercel CLI refuses temporary deploys in CI.")
    if (existsSync(join(project.root, ".vercel", "project.json"))) throw temporaryUnsupported("The folder is linked to a Vercel project in .vercel/project.json.")
  }
}

function credentialsMissing(host: DeployHost, credentials: Extract<HostCredentials, { ok: false }>, args: SetupDeployArgs): SetupFailure {
  const temporary = temporaryHosts.includes(host)
  const offer = temporary
    ? ` Or deploy without an account: run \`${rerunCommand(args, { temporary: true })}\`${host === "cloudflare" ? " and claim the Worker within 60 minutes" : " and claim the deployment with the link that it prints"}.`
    : ""
  return new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_CREDENTIALS_MISSING({ fix: `${credentials.fix}${offer}`, host }), setupExitCodes.inputNeeded, {
    missing: credentials.missing.map(field => ({ field })),
    ...(temporary ? { rerun: rerunCommand(args, { temporary: true }) } : {}),
  })
}

async function confirmDeploy(name: string, host: DeployHost, preview: boolean): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/iu.test((await terminal.question(`Deploy ${name} to ${host}${preview ? " as a preview" : " production"}? [y/N] `)).trim())
  }
  finally {
    terminal.close()
  }
}

async function build(project: SetupProject, context: ViteHubCliContext): Promise<void> {
  const command = `${project.packageManager} run build`
  const manifest: unknown = existsSync(join(project.root, "package.json")) ? JSON.parse(await readFile(join(project.root, "package.json"), "utf8")) : undefined
  if (!isRecord(manifest) || !isRecord(manifest.scripts) || typeof manifest.scripts.build !== "string") {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_BUILD_FAILED({ command }), setupExitCodes.error)
  }
  const result = await context.spawn(project.packageManager, ["run", "build"], { cwd: project.root, env: context.env, stdout: "stderr" })
  if (result.exitCode !== 0) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_BUILD_FAILED({ command, exitCode: result.exitCode ?? result.signal }), setupExitCodes.error)
}

interface BuildOutput {
  outputDir: string
  identityName?: string
}

/** Reads `<output>/deployment.json`, which the build writes, and checks that it is for `host`. */
async function readBuildOutput(root: string, host: DeployHost): Promise<BuildOutput> {
  const outputDir = join(root, resolveDeploymentPlan(host).output.directory)
  const file = join(outputDir, "deployment.json")
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(file, "utf8"))
  }
  catch {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file }), setupExitCodes.error)
  }
  const built = isRecord(manifest) ? optionalString(manifest.preset) : undefined
  if (built !== host) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_HOST_MISMATCH({ built: built ?? "an unknown host", host }), setupExitCodes.conflict)
  const identityName = isRecord(manifest) && isRecord(manifest.identity) ? optionalString(manifest.identity.name) : undefined
  return { outputDir, ...(identityName ? { identityName } : {}) }
}

async function hostAdapter(host: DeployHost, context: DeployContext): Promise<DeployAdapter> {
  switch (host) {
    case "cloudflare": return await cloudflareAdapter(context)
    case "vercel": return vercelAdapter(context)
    case "netlify": return netlifyAdapter(context)
    case "deno": return await denoAdapter(context, denoOrganization(context.link, context.env))
  }
}

/**
 * Sets the Console hash, then deploys. A normal deploy sets a host secret and checks that the host lists it. A host
 * project that does not exist yet gets a first deploy, so the secret has a place to go, then a second deploy reads it.
 */
async function deployWithConsole(adapter: DeployAdapter, host: DeployHost, pending: SetupConsoleLink | undefined, temporary: boolean): Promise<{ result: DeployResult, secret?: "set" | "var" }> {
  if (!pending) return { result: await adapter.deploy() }
  if (temporary) {
    // The hash is SHA-256 of a 256-bit random token, so it is not secret by itself, and a temporary account has no
    // login to set a host secret with. It goes into the build output as a plain runtime var.
    await adapter.setTemporaryVar!(CONSOLE_TOKEN_VARIABLE, pending.tokenSha256)
    return { result: await adapter.deploy(), secret: "var" }
  }
  if (!await adapter.projectExists()) await adapter.deploy()
  await adapter.setSecret(CONSOLE_TOKEN_VARIABLE, pending.tokenSha256)
  if (!await adapter.hasSecret(CONSOLE_TOKEN_VARIABLE)) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_SECRET_UNVERIFIED({ host, name: CONSOLE_TOKEN_VARIABLE }), setupExitCodes.error)
  }
  return { result: await adapter.deploy(), secret: "set" }
}

/** Records the host project after a first deploy, so `status` finds it. It stays unverified until `vitehub link`. */
async function recordLink(root: string, host: DeployHost, result: DeployResult, fallbackName: string, pending: SetupConsoleLink | undefined): Promise<void> {
  const project = result.project ?? { name: fallbackName }
  await writeSetupLinkFile(root, {
    schemaVersion: 1,
    host,
    ...(project.accountId ? { account: { id: project.accountId } } : {}),
    project: { ...(project.id ? { id: project.id } : {}), name: project.name },
    verified: false,
    linkedAt: new Date().toISOString(),
    ...(pending ? { console: pending } : {}),
  })
  await ensureViteHubGitignore(root)
}

function openInBrowser(url: string, context: ViteHubCliContext): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["explorer", [url]] : ["xdg-open", [url]]
  context.spawn(command, args, { env: context.env, stderr: "pipe", stdout: "pipe" }).catch(() => {})
}

function writeDeployed(output: SetupDeployOutput, name: string, context: ViteHubCliContext): void {
  context.stdout.write(`Deployed ${name} to ${output.host}: ${output.url}\n`)
  if (output.deploymentId) context.stdout.write(`Deployment: ${output.deploymentId}\n`)
  if (output.version) context.stdout.write(`Version: ${output.version}\n`)
  if (output.commit) context.stdout.write(`Commit: ${output.commit.sha}${output.commit.dirty ? " (with uncommitted changes)" : ""}\n`)
  if (output.temporary) {
    const window = output.host === "cloudflare" ? "within 60 minutes" : output.temporary.expiresAt ? `before ${output.temporary.expiresAt}` : "soon"
    context.stdout.write(`This is a temporary deploy. Claim it ${window}, or the host deletes it. Do not share the claim link:\n${output.temporary.claimUrl}\n`)
  }
  if (output.console) context.stdout.write(`Open this link to finish the Console link:\n${output.console.linkUrl}\n`)
}

async function runDeploy(args: SetupDeployArgs, context: ViteHubCliContext): Promise<number> {
  const project = await readSetupProject(context.rootDir, context.env)
  const link = await readSetupLink(project.root)
  const host = deployHost(project, link, context.env)
  if (args.preview && host === "deno") throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_PREVIEW_UNSUPPORTED({ host }), setupExitCodes.conflict)
  const credentials = await resolveHostCredentials(host, { cwd: project.root, env: context.env, ...(context.runHostCli ? { run: context.runHostCli } : {}) })
  if (args.temporary) assertTemporary(host, args, credentials, project, context.env)
  else if (!credentials.ok) throw credentialsMissing(host, credentials, args)

  const interactive = !args.json && !!process.stdin.isTTY && !!process.stderr.isTTY
  if (!args.yes) {
    if (!interactive) {
      throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] `vitehub deploy` publishes the app and was not confirmed. Without a terminal, pass --yes." }), setupExitCodes.inputNeeded, { rerun: rerunCommand(args) })
    }
    if (!await confirmDeploy(link?.project.name ?? basename(project.root), host, args.preview)) {
      throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The deploy was not confirmed. Nothing was deployed." }), setupExitCodes.error)
    }
  }

  if (args.build) await build(project, context)
  const output = await readBuildOutput(project.root, host)
  const projectName = link?.project.name ?? output.identityName
  if (!projectName) throw new SetupFailure(cliErrorDiagnostics.SETUP_LINK_NAME_REQUIRED(), setupExitCodes.inputNeeded, { missing: [{ field: "project" }], rerun: "vitehub link --project <name>" })
  const pending = await readSetupConsoleLink(project.root)
  const secrets = pending ? [pending.tokenSha256] : []
  const run = createDeployRun(context.stderr, secrets)
  const deployContext: DeployContext = {
    commit: await readDeployCommit(run, project.root, context.env),
    credentials,
    env: context.env,
    fetch: context.fetch ?? globalThis.fetch,
    link,
    outputDir: output.outputDir,
    preview: args.preview,
    projectName,
    root: project.root,
    run,
    secrets,
    temporary: args.temporary,
  }
  const adapter = await hostAdapter(host, deployContext)
  const { result, secret } = await deployWithConsole(adapter, host, pending, args.temporary)
  if (!link && !args.temporary) await recordLink(project.root, host, result, projectName, pending)

  const origin = new URL(result.url).origin
  const linkUrl = pending ? `${consoleLinkPage}#p=${encodeURIComponent(pending.pendingId)}&url=${encodeURIComponent(origin)}` : undefined
  const deployed: SetupDeployOutput = {
    host,
    url: result.url,
    ...(result.deploymentId ? { deploymentId: result.deploymentId } : {}),
    ...(result.version ? { version: result.version } : {}),
    ...(result.claim ? { temporary: { claimUrl: result.claim.url, ...(result.claim.expiresAt ? { expiresAt: result.claim.expiresAt } : {}) } } : {}),
    ...(linkUrl && secret ? { console: { linkUrl, secret } } : {}),
    ...(deployContext.commit ? { commit: deployContext.commit } : {}),
  }
  if (args.json) writeSetupJson(context, deployed)
  else writeDeployed(deployed, projectName, context)
  if (linkUrl && interactive) openInBrowser(linkUrl, context)
  return setupExitCodes.done
}

export const deployCommand: ViteHubCliCommand = {
  description: "Build the app and deploy it to its host with your local login. Sets the Console link secret when `vitehub init --console` left one.",
  name: "deploy",
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const parsed = readDeployArgs(args)
      if (parsed.help) {
        context.stdout.write(`Usage: ${usage}\n\n${deployCommand.description}\n`)
        return setupExitCodes.done
      }
      return await runDeploy(parsed, context)
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
  usage,
}

