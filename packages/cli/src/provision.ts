import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { resolveHostCredentials } from "@vite-hub/internal/host-credentials"
import { getProvisionStatePath, mergeProvisionState, readProvisionState, writeProvisionState } from "@vite-hub/internal/provision-state"
import { relative } from "pathe"
import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"
import { planProvisionSteps, resolveCloudflareProvisionConfig, resolveVercelProvisionConfig } from "@vite-hub/internal/provision"

import type { ViteHubCliCommandNamespace, ViteHubCliContext, ViteHubCliProvision } from "@vite-hub/internal/cli"
import type { HostCredentials } from "@vite-hub/internal/host-credentials"
import type {
  PlannedProvisionAction,
  ProvisionPlan,
  ProvisionProvider,
  ProvisionState,
  ProvisionStateCategory,
  ProvisionStep,
} from "@vite-hub/internal/provision"

import type { SetupLink } from "./setup/link.ts"

type ProvisionFeatureContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir" | "runHostCli" | "stderr" | "stdout">
type ProvisionCommand = "run" | "status"

/**
 * Loads the project config for a build on `host`, as `vitehub deploy --host` does, so a config that reads `detectHost()`
 * declares the resources of that host. Returns the Provision Steps, config root, and any environment loaded by discovery.
 */
export type LoadProvision = (host: ProvisionProvider) => Promise<ViteHubCliProvision & { env?: NodeJS.ProcessEnv }>

interface ParsedProvisionArgs {
  dryRun: boolean
  error?: string
  help: boolean
  host?: string
  json: boolean
}

const PROVISION_HOSTS = ["cloudflare", "vercel"] as const satisfies readonly ProvisionProvider[]
const HOST_CREDENTIALS = {
  cloudflare: "CLOUDFLARE_ACCOUNT_ID and a Cloudflare login (`wrangler login` or CLOUDFLARE_API_TOKEN)",
  vercel: "VERCEL_TOKEN",
} as const satisfies Record<ProvisionProvider, string>
const USAGE = {
  run: "vitehub provision run [--host <cloudflare|vercel>] [--dry-run] [--json]",
  status: "vitehub provision status [--host <cloudflare|vercel>] [--json]",
} as const satisfies Record<ProvisionCommand, string>

/** Whether ViteHub can provision resources on `host`. Only Cloudflare and Vercel have Provision Steps. */
export function isProvisionHost(value: string | undefined): value is ProvisionProvider {
  return PROVISION_HOSTS.some(host => host === value)
}

/** The ids of the selected deploy target, which take precedence over environment scope. */
export interface ProvisionLinkIds {
  accountId?: string
  projectId?: string
}

function setVariable(env: NodeJS.ProcessEnv, name: string, value: string | undefined): NodeJS.ProcessEnv {
  return env[name]?.trim() || !value ? env : { ...env, [name]: value }
}

/**
 * The environment of a Provision Step: `env` with the host credentials that `resolveHostCredentials` found, such as a
 * `wrangler login` token, and the account and project ids of the host link. The selected link wins over environment scope.
 */
export function provisionEnv(env: NodeJS.ProcessEnv, credentials: HostCredentials, link: ProvisionLinkIds = {}): NodeJS.ProcessEnv {
  if (!credentials.ok) return env
  if (credentials.host === "cloudflare") {
    return {
      ...setVariable(setVariable(env, "CLOUDFLARE_API_TOKEN", credentials.token), "CLOUDFLARE_ACCOUNT_ID", credentials.accountId),
      ...(link.accountId ? { CLOUDFLARE_ACCOUNT_ID: link.accountId } : {}),
    }
  }
  if (credentials.host === "vercel") {
    const teamId = credentials.teamId
    const resolved = setVariable(setVariable(env, "VERCEL_TOKEN", credentials.token), "VERCEL_TEAM_ID", teamId)
    if (!link.accountId && !link.projectId) return resolved
    return {
      ...resolved,
      ...(link.accountId ? { VERCEL_TEAM_ID: link.accountId.startsWith("team_") ? link.accountId : undefined, VERCEL_ORG_ID: undefined } : {}),
      ...(link.projectId ? { VERCEL_PROJECT_ID: link.projectId } : {}),
    }
  }
  return env
}

function parseArgs(command: ProvisionCommand, args: string[]): ParsedProvisionArgs {
  const parsed: ParsedProvisionArgs = { dryRun: false, help: false, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (arg === "--dry-run" && command === "run") parsed.dryRun = true
    else if (arg === "--host") {
      const host = args[index + 1]
      if (!host || host.startsWith("-")) parsed.error = "Option --host requires a value."
      else {
        parsed.host = host
        index++
      }
    }
    else if (arg?.startsWith("--host=")) {
      const host = arg.slice("--host=".length)
      if (!host) parsed.error = "Option --host requires a value."
      else parsed.host = host
    }
    else if (arg === "--provider" || arg?.startsWith("--provider=")) {
      const value = arg === "--provider" ? args[index + 1] : arg.slice("--provider=".length)
      const host = value && !value.startsWith("-") ? value : "<cloudflare|vercel>"
      return { ...parsed, error: `Option --provider is now --host.\nfix: run \`vitehub provision ${command} --host ${host}\`.` }
    }
    else if (arg) parsed.error = `Unknown provision argument: ${arg}`
  }
  return parsed
}

function writeUsage(command: ProvisionCommand, stream: ProvisionFeatureContext["stdout"]): void {
  const lines = command === "run"
    ? [
        `Usage: ${USAGE.run}`,
        "",
        "Idempotently creates missing host resources for the app's Definitions. `vitehub deploy` runs it before each deploy.",
        "Uses the credentials of `vitehub deploy`: environment variables first, then the `wrangler login` session.",
        "Never deletes resources. Changes an existing resource only for a planned update, such as D1 read replication.",
        "",
        "Options:",
        "  --host <name>      Target host: cloudflare or vercel. Without it, the host of `vitehub deploy`:",
        "                     the default target of .vitehub/link.json, else the only one, else `host` in vitehub().",
        "  --dry-run          Print the plan without applying it.",
        "  --json             Print one JSON result to stdout.",
        "  -h, --help         Show this help.",
      ]
    : [
        `Usage: ${USAGE.status}`,
        "",
        "Shows the ids recorded in .vitehub/provision.json and the actions the current plan would apply.",
        "Marks recorded ids that no Definition declares, with how to delete them on the host.",
        "Never creates or deletes provider resources, and never writes Provision State.",
        "",
        "Options:",
        "  --host <name>      Target host: cloudflare or vercel. Without it, the host of `vitehub deploy`.",
        "  --json             Print one JSON result to stdout.",
        "  -h, --help         Show this help.",
      ]
  stream.write(`${lines.join("\n")}\n\n`)
}

async function resolveHost(command: ProvisionCommand, parsed: ParsedProvisionArgs, context: ProvisionFeatureContext): Promise<{ exitCode: number } | { host: ProvisionProvider, link?: SetupLink }> {
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return { exitCode: 0 }
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\n`)
    writeUsage(command, context.stderr)
    return { exitCode: 1 }
  }
  let host = parsed.host
  let link: SetupLink | undefined
  if (host === undefined) {
    const { resolveDefaultDeployTarget } = await import("./setup/deploy.ts")
    try {
      const target = await resolveDefaultDeployTarget(resolveViteHubProjectRoot(context.rootDir), context.env, `vitehub provision ${command}`)
      host = target.host
      link = target.link
    }
    catch (error) {
      context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
      return { exitCode: 1 }
    }
    if (!isProvisionHost(host)) {
      context.stderr.write(`The host of this project is ${host}, and provision supports cloudflare and vercel. Pass --host cloudflare|vercel to provision another host.\n`)
      return { exitCode: 1 }
    }
  }
  if (!isProvisionHost(host)) {
    context.stderr.write("Provision requires --host cloudflare|vercel.\n")
    writeUsage(command, context.stderr)
    return { exitCode: 1 }
  }
  return { host, ...(link ? { link } : {}) }
}

function hasHostCredentials(host: ProvisionProvider, env: ProvisionFeatureContext["env"]): boolean {
  return Boolean(host === "cloudflare" ? resolveCloudflareProvisionConfig(env) : resolveVercelProvisionConfig(env))
}

async function withHostCredentials(host: ProvisionProvider, context: ProvisionFeatureContext, link?: SetupLink): Promise<ProvisionFeatureContext> {
  const credentials = await resolveHostCredentials(host, { cwd: context.rootDir, env: context.env, ...(context.runHostCli ? { run: context.runHostCli } : {}) })
  return { ...context, env: provisionEnv(context.env, credentials, {
    ...(link?.account?.id ? { accountId: link.account.id } : {}),
    ...(link?.project.id ? { projectId: link.project.id } : {}),
  }) }
}

async function planProvision(provider: ProvisionProvider, context: ProvisionFeatureContext, steps: readonly ProvisionStep[], json: boolean): Promise<ProvisionPlan> {
  return await planProvisionSteps(provider, [...steps], {
    env: context.env,
    fetch: globalThis.fetch,
    logger: {
      log: message => (json ? context.stderr : context.stdout).write(`${message}\n`),
      warn: message => { if (!json) context.stderr.write(`${message}\n`) },
    },
  })
}

interface UndeclaredProvisionEntry {
  category: string
  fix: string
  id: string
  key: string
}

/** The path of the Provision State file of `rootDir` as the user sees it from `cwd`, such as `app/.vitehub/provision.json` in a Nuxt app. */
export function provisionStateFile(rootDir: string, cwd: string): string {
  return relative(cwd, getProvisionStatePath(rootDir))
}

function findUndeclaredEntries(
  provider: ProvisionProvider,
  recorded: Record<string, Record<string, string>>,
  steps: readonly ProvisionStep[],
  env: ProvisionFeatureContext["env"],
  stateFile: string,
): UndeclaredProvisionEntry[] {
  const categories = new Map<string, ProvisionStateCategory>()
  const unverifiedDeclarations = new Set<string>()
  const activeDeclarations = new Set<string>()
  for (const step of steps) {
    if (step.provider !== provider) continue
    const described = step.recordedState?.({ env }) ?? []
    for (const category of described) categories.set(category.category, category)
    if (described.some(category => category.declared.length)) {
      for (const category of described) activeDeclarations.add(category.category)
    }
    if (described.some(category => category.declared.some(key => {
      const ids = recorded[category.category] ?? {}
      const id = Object.hasOwn(ids, key) ? ids[key] : undefined
      const expected = category.declaredResourceIdentity?.(key)
      const identity = id === undefined ? undefined : category.resourceIdentity ? category.resourceIdentity({ id, key }) : id
      return expected === undefined || identity === undefined || identity !== expected
    }))) {
      for (const category of described) unverifiedDeclarations.add(category.category)
    }
  }
  const resourceIdentity = (category: string, key: string, id: string) => {
    const describe = categories.get(category)?.resourceIdentity
    return describe ? describe({ id, key }) : id
  }
  const isDeclared = (category: string, key: string, id: string) => {
    const description = categories.get(category)
    if (!description?.declared.includes(key)) return false
    const expected = description.declaredResourceIdentity?.(key)
    const identity = resourceIdentity(category, key, id)
    return expected === undefined || identity === undefined || identity === expected
  }
  const declaredById = new Map<string, string>()
  for (const [category, ids] of Object.entries(recorded)) {
    for (const [key, id] of Object.entries(ids)) {
      const identity = resourceIdentity(category, key, id)
      if (identity !== undefined && isDeclared(category, key, id) && !declaredById.has(identity)) declaredById.set(identity, `${category} ${JSON.stringify(key)}`)
    }
  }
  const stateEdit = `remove the entry from ${stateFile}`
  const entries: UndeclaredProvisionEntry[] = []
  for (const [category, ids] of Object.entries(recorded)) {
    for (const [key, id] of Object.entries(ids)) {
      if (isDeclared(category, key, id)) continue
      const identity = resourceIdentity(category, key, id)
      const sharedWith = identity === undefined ? undefined : declaredById.get(identity)
      let fix: string
      if (sharedWith) fix = `${sharedWith} uses the same id, so keep the resource and only ${stateEdit}.`
      else if (unverifiedDeclarations.has(category) || (identity === undefined && activeDeclarations.has(category))) {
        fix = "A current Definition may still use this recorded resource, but its identity cannot be verified from local state and config. Verify its resource id before deleting anything by comparing the provider's resource names and bindings with current Definitions."
      }
      else {
        const deleteHint = categories.get(category)?.deleteHint({ id, key }) ?? `delete resource ${id} in the ${provider === "cloudflare" ? "Cloudflare" : "Vercel"} dashboard`
        fix = `No Definition declares it. If no deployment uses ${id}, ${deleteHint}, then ${stateEdit}.`
      }
      entries.push({ category, fix, id, key })
    }
  }
  return entries
}

function serializeAction({ action, step }: PlannedProvisionAction) {
  return {
    ...(action.pending === undefined ? {} : { pending: action.pending }),
    exists: action.exists,
    kind: action.kind,
    name: action.name,
    step,
    ...(action.update === undefined ? {} : { update: action.update }),
  }
}

export type ProvisionActionStatus = "create" | "update" | "pending" | "exists"

export function provisionActionStatus({ action }: PlannedProvisionAction): ProvisionActionStatus {
  return !action.exists ? "create" : action.update ? "update" : action.pending ? "pending" : "exists"
}

export function writeProvisionActions(actions: readonly PlannedProvisionAction[], stdout: ProvisionFeatureContext["stdout"]): void {
  for (const planned of actions) {
    const { action } = planned
    stdout.write(`${provisionActionStatus(planned)}\t${action.kind}\t${action.name}${action.update ? `\t${action.update}` : ""}\n`)
  }
}

async function runProvision(args: string[], cliContext: ProvisionFeatureContext, load: LoadProvision): Promise<number> {
  const parsed = parseArgs("run", args)
  const resolved = await resolveHost("run", parsed, cliContext)
  if ("exitCode" in resolved) return resolved.exitCode
  const { host: provider } = resolved
  const { env = cliContext.env, rootDir, steps } = await load(provider)
  const context = await withHostCredentials(provider, { ...cliContext, env, rootDir }, resolved.link)

  if (!parsed.dryRun && !hasHostCredentials(provider, context.env)) {
    context.stderr.write(`Provision requires ${HOST_CREDENTIALS[provider]}. Dry-run preview does not require credentials (--dry-run).\n`)
    return 1
  }

  if (!parsed.dryRun) await readProvisionState(context.rootDir)

  const { actions, checked, warnings } = await planProvision(provider, context, steps, parsed.json)
  const blocked = !checked && !parsed.dryRun
  if (!parsed.json) {
    if (!checked) context.stdout.write("provision: plan not checked.\n")
    if (blocked) {
      context.stderr.write("provision: nothing applied. Fix the warnings above, or preview with --dry-run.\n")
      return 1
    }
    if (!actions.length) {
      if (checked) context.stdout.write(`provision: no ${provider} resources to create.\n`)
      return 0
    }
    writeProvisionActions(actions, context.stdout)
  }

  let state: ProvisionState = {}
  if (!parsed.dryRun && !blocked) {
    for (const { action } of actions) {
      const result = await action.apply()
      if (result.ids) state = mergeProvisionState(state, result.ids)
    }
  }
  const wroteState = Object.keys(state).length > 0
  if (wroteState) await writeProvisionState(context.rootDir, state)

  if (parsed.json) {
    if (blocked) context.stderr.write("provision: plan not checked, nothing applied. Read warnings in the JSON result.\n")
    context.stdout.write(`${JSON.stringify({
      actions: actions.map(serializeAction),
      checked,
      ids: state[provider] ?? {},
      mode: parsed.dryRun ? "dry-run" : "apply",
      provider,
      schemaVersion: 1,
      stateFile: wroteState ? provisionStateFile(context.rootDir, context.cwd) : null,
      warnings,
    })}\n`)
  }
  else if (wroteState) {
    context.stdout.write(`provision: wrote ids to ${provisionStateFile(context.rootDir, context.cwd)}\n`)
  }
  return blocked ? 1 : 0
}

async function runProvisionStatus(args: string[], cliContext: ProvisionFeatureContext, load: LoadProvision): Promise<number> {
  const parsed = parseArgs("status", args)
  const resolved = await resolveHost("status", parsed, cliContext)
  if ("exitCode" in resolved) return resolved.exitCode
  const { host: provider } = resolved
  const { env = cliContext.env, rootDir, steps } = await load(provider)
  const context = await withHostCredentials(provider, { ...cliContext, env, rootDir }, resolved.link)

  const recorded = (await readProvisionState(context.rootDir))[provider] ?? {}
  const stateFile = provisionStateFile(context.rootDir, context.cwd)
  const undeclared = findUndeclaredEntries(provider, recorded, steps, context.env, stateFile)
  const hasCredentials = hasHostCredentials(provider, context.env)
  const { actions, checked, warnings } = hasCredentials
    ? await planProvision(provider, context, steps, parsed.json)
    : { actions: [], checked: false, warnings: [`provision: plan not checked, missing ${HOST_CREDENTIALS[provider]}.`] }
  const pending = actions.filter(({ action }) => action.pending ?? !action.exists).length

  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({
      plan: {
        actions: actions.map(serializeAction),
        checked,
        pending,
      },
      provider,
      recorded,
      schemaVersion: 1,
      stateFile,
      undeclared,
      warnings,
    })}\n`)
    return 0
  }

  const isUndeclared = (category: string, key: string) => undeclared.some(entry => entry.category === category && entry.key === key)
  const recordedEntries = Object.entries(recorded)
    .flatMap(([category, ids]) => Object.entries(ids).map(([key, id]) => `${category}\t${key}\t${id}${isUndeclared(category, key) ? "\tnot declared" : ""}\n`))
  if (recordedEntries.length) {
    context.stdout.write(`recorded ${provider} ids (${stateFile}):\n`)
    for (const entry of recordedEntries) context.stdout.write(entry)
    for (const entry of undeclared) context.stdout.write(`fix: ${entry.category} ${JSON.stringify(entry.key)}: ${entry.fix}\n`)
  }
  else {
    context.stdout.write(`recorded ${provider} ids: none in ${stateFile}\n`)
  }

  if (!checked) {
    if (!hasCredentials) context.stderr.write(`${warnings[0]}\n`)
    context.stdout.write("plan: not checked\n")
    return 0
  }
  writeProvisionActions(actions, context.stdout)
  context.stdout.write(pending
    ? `plan: ${pending} pending ${pending === 1 ? "action" : "actions"}. Run \`vitehub provision run --host ${provider}\` to apply.\n`
    : "plan: no pending actions\n")
  return 0
}

/**
 * Built-in namespace that orchestrates package-contributed Provision Steps. `load` reads the steps of a build for the
 * `--host` of the command, so `provision run --host cloudflare` plans what `vitehub deploy --host cloudflare` creates.
 */
export function createProvisionNamespace(load: LoadProvision): ViteHubCliCommandNamespace {
  return {
    description: "Idempotently create missing provider resources.",
    features: [{
      description: "Create missing provider resources for the app's Definitions.",
      name: "run",
      run: (args, context) => runProvision(args, context, load),
      usage: USAGE.run,
    }, {
      description: "Show recorded provider ids and pending plan actions.",
      name: "status",
      run: (args, context) => runProvisionStatus(args, context, load),
      usage: USAGE.status,
    }],
    name: "provision",
  }
}
