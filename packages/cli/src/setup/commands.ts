import { addCommand } from "./add.ts"
import { deployCommand } from "./deploy.ts"
import { initCommandDefinition, readSetupStack } from "./init.ts"
import { parseArgs } from "node:util"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { setupCatalog } from "./catalog.ts"
import { readSetupArgs, setupExitCodes, table, writeSetupError, writeSetupJson } from "./envelope.ts"
import { deploymentsCommand, liveLabel, readSetupLive } from "./deployments.ts"
import { linkSetupProject, readSetupLinkState, SETUP_LINK_FILE, unlinkSetupProject } from "./link.ts"
import { readSetupProject } from "./project.ts"
import { removeCommand } from "./remove.ts"
import { setupStatus } from "./status.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { SetupLiveStatus } from "./deployments.ts"
import type { SetupLinkResult, SetupLinkStatus } from "./link.ts"
import type { SetupFeatureStatus, SetupStatus } from "./status.ts"

function supportLabel(support: SetupFeatureStatus["support"]): string {
  if (support.level === "unknown") return "unknown"
  if (support.level === "unsupported") return "-"
  return support.level === "explicit" ? `${support.display} (set ${support.option})` : support.display
}

function writeHelp(command: ViteHubCliCommand, context: ViteHubCliContext): number {
  context.stdout.write(`Usage: ${command.usage}\n\n${command.description}\n`)
  return setupExitCodes.done
}

/** Runs `body` and reports any error in the setup envelope. */
async function runSetupCommand(command: ViteHubCliCommand, args: string[], context: ViteHubCliContext, body: (json: boolean) => Promise<number>): Promise<number> {
  const json = args.includes("--json")
  try {
    const parsed = readSetupArgs(args, command.usage)
    if (parsed.help) return writeHelp(command, context)
    return await body(parsed.json)
  }
  catch (error: unknown) {
    return writeSetupError(context, json, error)
  }
}

const catalogCommand: ViteHubCliCommand = {
  description: "List every ViteHub feature and how each host supports it. Needs no project.",
  name: "catalog",
  run: (args, context) => runSetupCommand(catalogCommand, args, context, async (json) => {
    const catalog = setupCatalog()
    if (json) {
      writeSetupJson(context, catalog)
      return setupExitCodes.done
    }
    context.stdout.write(`${table([
      ["feature", ...catalog.hosts],
      ...catalog.features.map(feature => [feature.id, ...catalog.hosts.map(host => supportLabel(feature.hosts[host]))]),
    ])}\n\n"-" is unsupported. Run \`vitehub catalog --json\` for packages, docs, and details.\n`)
    return setupExitCodes.done
  }),
  usage: "vitehub catalog [--json]",
}

function configLabel(config: SetupStatus["config"]): string {
  if ("form" in config) return `${config.file} (${config.form})`
  const at = config.file ? `${config.file}${config.line === undefined ? "" : `:${config.line}`}: ` : ""
  return `${at}manual (${config.manual})`
}

function linkLabel(link: SetupLinkStatus["link"]): string {
  if (!link) return "none (run `vitehub link`)"
  const account = link.account ? ` in ${link.account.name ?? link.account.id}` : ""
  return `${link.project.name} on ${link.host}${account}${link.verified ? "" : " (not verified)"}`
}

function credentialsLabel(credentials: SetupLinkStatus["credentials"]): string {
  if (!credentials) return "not needed"
  return credentials.ok ? `${credentials.host} (${credentials.source})` : `missing: ${credentials.fix}`
}

function writeStatus(status: SetupStatus & SetupLinkStatus & SetupLiveStatus & { stack: { command: string } | null }, context: ViteHubCliContext): void {
  const shown = status.features.filter(feature => feature.enabled !== "off")
  const off = status.features.length - shown.length
  context.stdout.write(`${table([
    ["root", status.root],
    ["framework", status.framework],
    ["config", configLabel(status.config)],
    ["host", `${status.host.name} (${status.host.source})`],
    ["packages", status.packageManager],
    ["link", linkLabel(status.link)],
    ["credentials", credentialsLabel(status.credentials)],
    ["live", liveLabel(status)],
    ...(status.console ? [["console", `pending link ${status.console.pendingId}`]] : []),
    ...(status.stack ? [["stack", status.stack.command]] : []),
  ])}\n\n`)
  if (shown.length) {
    context.stdout.write(`${table([
      ["feature", "state", "support", "fix"],
      ...shown.map(feature => [feature.id, feature.reason === "config" ? feature.enabled : `${feature.enabled} (${feature.reason})`, supportLabel(feature.support), feature.fix ?? ""]),
    ])}\n\n`)
  }
  context.stdout.write(`${off} features are off. Run \`vitehub catalog\` to list them.\n`)
}

const statusUsage = "vitehub status [--offline] [--json]"

const statusCommand: ViteHubCliCommand = {
  description: "Show the host, the enabled features, what each one still needs, and the live deployment. Reads the config without running it. --offline skips the host request.",
  name: "status",
  run: (args, context) => {
    const offline = args.includes("--offline")
    return runSetupCommand(statusCommand, args.filter(arg => arg !== "--offline"), context, async (json) => {
      const project = await readSetupProject(context.rootDir, context.env)
      const features = setupStatus(project, context.env)
      const state = await readSetupLinkState(project, features.host.name, context)
      const status = {
        ...features,
        ...state.status,
        ...await readSetupLive(project.root, state.link, state.credentials, context, { offline }),
        stack: await readSetupStack(project.root),
      }
      if (json) writeSetupJson(context, status)
      else writeStatus(status, context)
      return setupExitCodes.done
    })
  },
  usage: statusUsage,
}

const linkUsage = "vitehub link [--host <preset>] [--project <name>] [--account <id>] [--create] [--json]"

function readLinkArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        account: { type: "string" },
        create: { type: "boolean", default: false },
        help: { short: "h", type: "boolean", default: false },
        host: { type: "string" },
        json: { type: "boolean", default: false },
        project: { type: "string" },
      },
      strict: true,
    }).values
  }
  catch (error: unknown) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${linkUsage}` })
  }
}

function writeLinked(result: SetupLinkResult, context: ViteHubCliContext): void {
  const { link } = result
  const account = link.account ? ` in account ${link.account.name ?? link.account.id}` : ""
  context.stdout.write(`${result.created ? "Created and linked" : "Linked"} ${link.project.name} on ${link.host}${account}.\n`)
  if (!link.verified) context.stdout.write(`The ${link.host} API was not asked, so the project is not verified.\n`)
  context.stdout.write(`Wrote ${result.file}. It holds no secret.\n`)
  if (result.gitignore === "added") context.stdout.write("Added .vitehub to .gitignore.\n")
  if (result.gitignore === "no-gitignore") context.stderr.write("[vitehub] The project has no .gitignore. Do not commit the .vitehub folder.\n")
}

const linkCommand: ViteHubCliCommand = {
  description: "Link this project to a project on its host. Writes .vitehub/link.json, which holds no secret.",
  name: "link",
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const values = readLinkArgs(args)
      if (values.help) return writeHelp(linkCommand, context)
      const project = await readSetupProject(context.rootDir, context.env)
      const result = await linkSetupProject(project, { account: values.account, create: values.create, host: values.host, project: values.project }, context)
      if (json) writeSetupJson(context, result)
      else writeLinked(result, context)
      return setupExitCodes.done
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
  usage: linkUsage,
}

const unlinkCommand: ViteHubCliCommand = {
  description: "Remove the link to the host project. The project on the host does not change.",
  name: "unlink",
  run: (args, context) => runSetupCommand(unlinkCommand, args, context, async (json) => {
    const project = await readSetupProject(context.rootDir, context.env)
    const removed = await unlinkSetupProject(project.root)
    if (json) writeSetupJson(context, { file: SETUP_LINK_FILE, removed })
    else context.stdout.write(removed ? `Removed ${SETUP_LINK_FILE}.\n` : "The project is not linked.\n")
    return setupExitCodes.done
  }),
  usage: "vitehub unlink [--json]",
}

/** The setup commands. They run before the CLI loads the project config. */
export const setupCommands: readonly ViteHubCliCommand[] = [initCommandDefinition, addCommand, removeCommand, catalogCommand, statusCommand, linkCommand, unlinkCommand, deployCommand, deploymentsCommand]
