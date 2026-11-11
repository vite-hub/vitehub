import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import process from "node:process"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"

import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { resolveHostCredentials } from "@vite-hub/internal/host-credentials"
import { basename, join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { checkoutPushError, formatDeployCheckouts, prepareDeployCheckouts, pushDeployCheckouts } from "./deploy/checkouts.ts"
import { cloudflareAdapter } from "./deploy/cloudflare.ts"
import { denoAdapter, denoOrganization } from "./deploy/deno.ts"
import { createDeployRun, isRecord, optionalString, readDeployCommit } from "./deploy/host.ts"
import { netlifyAdapter } from "./deploy/netlify.ts"
import { hasVercelLogin, vercelAdapter } from "./deploy/vercel.ts"
import { SetupFailure, setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"
import { ensureViteHubGitignore, readSetupLink, writeSetupLinkFile } from "./link.ts"
import { readSetupProject } from "./project.ts"
import { setupStatus } from "./status.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { HostCredentials } from "@vite-hub/internal/host-credentials"
import type { DeployCheckouts, DeployCheckoutsOutput } from "./deploy/checkouts.ts"
import type { DeployAdapter, DeployCommit, DeployContext, DeployHost, DeployResult } from "./deploy/host.ts"
import type { SetupLink } from "./link.ts"
import type { SetupProject } from "./project.ts"

const deployHosts: readonly DeployHost[] = ["cloudflare", "vercel", "netlify", "deno"]
const temporaryHosts: readonly DeployHost[] = ["cloudflare", "vercel"]

const usage = "vitehub deploy [--preview] [--no-build] [--no-push] [--temporary] [--yes] [--json]"

const help = `With checkout folders in vitehub.lock, a production deploy pulls them and checks for conflicts before the build, and
pushes them after the deploy, as \`vitehub push\` does. A --preview deploy does not push, so a preview never writes
the shared Workspace ref. --no-push skips the pull, the check and the push.
`

export interface SetupDeployArgs {
  preview: boolean
  build: boolean
  /** False with --no-push. A preview deploy never pushes. */
  push: boolean
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
  commit?: DeployCommit
  /** The Workspace push of the checkout folders of `vitehub.lock`. Missing when the deploy did not push. */
  checkouts?: DeployCheckoutsOutput
}

export function readDeployArgs(args: readonly string[]): SetupDeployArgs {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        "help": { short: "h", type: "boolean", default: false },
        "json": { type: "boolean", default: false },
        "no-build": { type: "boolean", default: false },
        "no-push": { type: "boolean", default: false },
        "preview": { type: "boolean", default: false },
        "temporary": { type: "boolean", default: false },
        "yes": { short: "y", type: "boolean", default: false },
      },
      strict: true,
    })
    return { build: !values["no-build"], help: values.help, json: values.json, preview: values.preview, push: !values["no-push"], temporary: values.temporary, yes: values.yes }
  }
  catch (error: unknown) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${usage}` })
  }
}

function rerunCommand(args: SetupDeployArgs, extra: { temporary?: boolean } = {}): string {
  return ["vitehub deploy", ...(args.preview ? ["--preview"] : []), ...(args.build ? [] : ["--no-build"]), ...(args.push ? [] : ["--no-push"]), ...(args.temporary || extra.temporary ? ["--temporary"] : []), "--yes", ...(args.json ? ["--json"] : [])].join(" ")
}

function deployHost(project: SetupProject, link: SetupLink | undefined, env: NodeJS.ProcessEnv): DeployHost {
  const configured = setupStatus(project, env).host
  if (link && configured.source === "config" && configured.name !== "unknown" && configured.name !== link.host) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_HOST_MISMATCH({ built: configured.name, host: link.host }), setupExitCodes.conflict)
  }
  const host = link?.host ?? configured.name
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
  const built = isRecord(manifest) ? optionalString(manifest.host) : undefined
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

/** Records the host project after a first deploy, so `status` finds it. It stays unverified until `vitehub link`. */
async function recordLink(root: string, host: DeployHost, result: DeployResult, fallbackName: string): Promise<void> {
  const project = result.project ?? { name: fallbackName }
  await writeSetupLinkFile(root, {
    schemaVersion: 1,
    host,
    ...(project.accountId ? { account: { id: project.accountId } } : {}),
    project: { ...(project.id ? { id: project.id } : {}), name: project.name },
    verified: false,
    linkedAt: new Date().toISOString(),
  })
  await ensureViteHubGitignore(root)
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
}

/** Pushes the checkout folders after the deploy. A failed push does not undo the deploy, so it exits with 1 and says so. */
async function pushCheckouts(checkouts: DeployCheckouts, deployed: SetupDeployOutput, args: SetupDeployArgs, context: ViteHubCliContext): Promise<SetupDeployOutput> {
  try {
    const pushed = await pushDeployCheckouts(checkouts, context)
    if (!args.json) context.stdout.write(formatDeployCheckouts(pushed))
    return { ...deployed, checkouts: pushed }
  }
  catch (error: unknown) {
    const failure = checkoutPushError(error)
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_PUSH_FAILED({ fix: failure.fix, message: `${failure.code}: ${failure.message}`, url: deployed.url }), setupExitCodes.error, {
      data: { ...deployed, checkouts: { error: failure } },
      rerun: "vitehub push",
    })
  }
}

async function runDeploy(args: SetupDeployArgs, context: ViteHubCliContext): Promise<number> {
  const project = await readSetupProject(context.rootDir, context.env)
  const link = await readSetupLink(project.root)
  const host = deployHost(project, link, context.env)
  if (args.preview && host === "deno") throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_PREVIEW_UNSUPPORTED({ host }), setupExitCodes.conflict)
  const credentials = await resolveHostCredentials(host, { cwd: project.root, env: context.env, ...(context.runHostCli ? { run: context.runHostCli } : {}) })
  const vercelLogin = host === "vercel" && !credentials.ok && await hasVercelLogin(project.root, context)
  if (args.temporary && vercelLogin) throw temporaryUnsupported("It is for a machine without a vercel login, and a saved CLI login was found.")
  if (args.temporary) assertTemporary(host, args, credentials, project, context.env)
  else if (!credentials.ok && !vercelLogin) throw credentialsMissing(host, credentials, args)

  const interactive = !args.json && !!process.stdin.isTTY && !!process.stderr.isTTY
  if (!args.yes) {
    if (!interactive) {
      throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] `vitehub deploy` publishes the app and was not confirmed. Without a terminal, pass --yes." }), setupExitCodes.inputNeeded, { rerun: rerunCommand(args) })
    }
    if (!await confirmDeploy(link?.project.name ?? basename(project.root), host, args.preview)) {
      throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The deploy was not confirmed. Nothing was deployed." }), setupExitCodes.error)
    }
  }

  // A preview must not write the shared Workspace ref, so only a production deploy pushes. This imports project code,
  // so it runs only after the confirmation.
  const checkouts = args.push && !args.preview ? await prepareDeployCheckouts(project.root, context) : undefined
  if (args.build) await build(project, context)
  const output = await readBuildOutput(project.root, host)
  const projectName = link?.project.name ?? output.identityName
  if (!projectName) throw new SetupFailure(cliErrorDiagnostics.SETUP_LINK_NAME_REQUIRED(), setupExitCodes.inputNeeded, { missing: [{ field: "project" }], rerun: "vitehub link --project <name>" })
  const secrets = credentials.ok ? [credentials.token] : []
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
  const result = await adapter.deploy()
  if (!link && !args.temporary) await recordLink(project.root, host, result, projectName)

  const deployed: SetupDeployOutput = {
    host,
    url: result.url,
    ...(result.deploymentId ? { deploymentId: result.deploymentId } : {}),
    ...(result.version ? { version: result.version } : {}),
    ...(result.claim ? { temporary: { claimUrl: result.claim.url, ...(result.claim.expiresAt ? { expiresAt: result.claim.expiresAt } : {}) } } : {}),
    ...(deployContext.commit ? { commit: deployContext.commit } : {}),
  }
  if (!args.json) writeDeployed(deployed, projectName, context)
  const final = checkouts ? await pushCheckouts(checkouts, deployed, args, context) : deployed
  if (args.json) writeSetupJson(context, final)
  return setupExitCodes.done
}

export const deployCommand: ViteHubCliCommand = {
  description: "Build the app and deploy it to its host with your local login. Pushes the checkout folders of vitehub.lock.",
  name: "deploy",
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const parsed = readDeployArgs(args)
      if (parsed.help) {
        context.stdout.write(`Usage: ${usage}\n\n${deployCommand.description}\n\n${help}`)
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
