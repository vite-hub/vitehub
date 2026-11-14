import { resolveHostCredentials } from "@vite-hub/internal/host-credentials"
import { mergeProvisionState, PROVISION_STATE_FILE, readProvisionState, writeProvisionState } from "@vite-hub/internal/provision-state"
import { planProvisionSteps, resolveCloudflareProvisionConfig, resolveVercelProvisionConfig } from "@vite-hub/internal/provision"

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { HostCredentials } from "@vite-hub/internal/host-credentials"
import type {
  PlannedProvisionAction,
  ProvisionPlan,
  ProvisionProvider,
  ProvisionState,
  ProvisionStateCategory,
  ProvisionStep,
} from "@vite-hub/internal/provision"

type ProvisionFeatureContext = Pick<ViteHubCliContext, "env" | "rootDir" | "runHostCli" | "stderr" | "stdout">
type ProvisionCommand = "run" | "status"

interface ProvisionFeatureOptions {
  collectSteps: () => Promise<ProvisionStep[]>
}

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
  run: "vitehub provision run --host <cloudflare|vercel> [--dry-run] [--json]",
  status: "vitehub provision status --host <cloudflare|vercel> [--json]",
} as const satisfies Record<ProvisionCommand, string>

/** Whether ViteHub can provision resources on `host`. Only Cloudflare and Vercel have Provision Steps. */
export function isProvisionHost(value: string | undefined): value is ProvisionProvider {
  return PROVISION_HOSTS.some(host => host === value)
}

/** The ids of a host link that provision can use when the environment does not set them. */
export interface ProvisionLinkIds {
  accountId?: string
  projectId?: string
}

function setVariable(env: NodeJS.ProcessEnv, name: string, value: string | undefined): NodeJS.ProcessEnv {
  return env[name]?.trim() || !value ? env : { ...env, [name]: value }
}

/**
 * The environment of a Provision Step: `env` with the host credentials that `resolveHostCredentials` found, such as a
 * `wrangler login` token, and the account and project ids of the host link. A value that `env` sets wins.
 */
export function provisionEnv(env: NodeJS.ProcessEnv, credentials: HostCredentials, link: ProvisionLinkIds = {}): NodeJS.ProcessEnv {
  if (!credentials.ok) return env
  if (credentials.host === "cloudflare") {
    return setVariable(setVariable(env, "CLOUDFLARE_API_TOKEN", credentials.token), "CLOUDFLARE_ACCOUNT_ID", credentials.accountId ?? link.accountId)
  }
  if (credentials.host === "vercel") {
    // A Vercel link stores the project owner, which is a user id on a personal account. Only a team id is a team.
    const teamId = credentials.teamId ?? (link.accountId?.startsWith("team_") ? link.accountId : undefined)
    return setVariable(setVariable(setVariable(env, "VERCEL_TOKEN", credentials.token), "VERCEL_TEAM_ID", teamId), "VERCEL_PROJECT_ID", link.projectId)
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
        "  --host <name>      Target host: cloudflare or vercel (required).",
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
        "  --host <name>      Target host: cloudflare or vercel (required).",
        "  --json             Print one JSON result to stdout.",
        "  -h, --help         Show this help.",
      ]
  stream.write(`${lines.join("\n")}\n\n`)
}

// Resolves the arguments shared by every provision command. Returns an exit code on failure or help.
function resolveHost(command: ProvisionCommand, parsed: ParsedProvisionArgs, context: ProvisionFeatureContext): { exitCode: number } | { host: ProvisionProvider } {
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return { exitCode: 0 }
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\n`)
    writeUsage(command, context.stderr)
    return { exitCode: 1 }
  }
  if (!isProvisionHost(parsed.host)) {
    context.stderr.write("Provision requires --host cloudflare|vercel.\n")
    writeUsage(command, context.stderr)
    return { exitCode: 1 }
  }
  return { host: parsed.host }
}

function hasHostCredentials(host: ProvisionProvider, env: ProvisionFeatureContext["env"]): boolean {
  return Boolean(host === "cloudflare" ? resolveCloudflareProvisionConfig(env) : resolveVercelProvisionConfig(env))
}

/** The context with the credentials of `resolveHostCredentials` in its env, so a `wrangler login` works as in deploy. */
async function withHostCredentials(host: ProvisionProvider, context: ProvisionFeatureContext): Promise<ProvisionFeatureContext> {
  const credentials = await resolveHostCredentials(host, { cwd: context.rootDir, env: context.env, ...(context.runHostCli ? { run: context.runHostCli } : {}) })
  return { ...context, env: provisionEnv(context.env, credentials) }
}

// Runs only the plan phase. Step messages go to stderr so stdout stays one JSON document in --json mode.
async function planProvision(provider: ProvisionProvider, context: ProvisionFeatureContext, options: ProvisionFeatureOptions, json: boolean): Promise<ProvisionPlan> {
  return await planProvisionSteps(provider, await options.collectSteps(), {
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

// Lists recorded ids that no current Definition uses, for example after a rename. Never deletes anything.
function findUndeclaredEntries(
  provider: ProvisionProvider,
  recorded: Record<string, Record<string, string>>,
  steps: readonly ProvisionStep[],
  env: ProvisionFeatureContext["env"],
): UndeclaredProvisionEntry[] {
  const categories = new Map<string, ProvisionStateCategory>()
  const unverifiedDeclarations = new Set<string>()
  const activeDeclarations = new Set<string>()
  for (const step of steps) {
    if (step.provider !== provider) continue
    const described = step.recordedState?.({ env }) ?? []
    for (const category of described) categories.set(category.category, category)
    // A rename can target a key with a stale id. Key presence alone cannot verify ownership.
    // Include sibling categories, such as d1 and d1Nuxt, that can refer to the same resource.
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
    // Keep key-based declarations when identities are unknown, but report definite config changes.
    return expected === undefined || identity === undefined || identity === expected
  }
  const declaredById = new Map<string, string>()
  for (const [category, ids] of Object.entries(recorded)) {
    for (const [key, id] of Object.entries(ids)) {
      const identity = resourceIdentity(category, key, id)
      if (identity !== undefined && isDeclared(category, key, id) && !declaredById.has(identity)) declaredById.set(identity, `${category} ${JSON.stringify(key)}`)
    }
  }
  const stateEdit = `remove the entry from ${PROVISION_STATE_FILE}`
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

async function runProvision(args: string[], cliContext: ProvisionFeatureContext, options: ProvisionFeatureOptions): Promise<number> {
  const parsed = parseArgs("run", args)
  const resolved = resolveHost("run", parsed, cliContext)
  if ("exitCode" in resolved) return resolved.exitCode
  const { host: provider } = resolved
  const context = await withHostCredentials(provider, cliContext)

  // Fail closed outside --dry-run: a credential-less run silently creating
  // nothing would mask missing CI secrets behind a green step.
  if (!parsed.dryRun && !hasHostCredentials(provider, context.env)) {
    context.stderr.write(`Provision requires ${HOST_CREDENTIALS[provider]}. Dry-run preview does not require credentials (--dry-run).\n`)
    return 1
  }

  // Reject unreadable state before providers can create resources whose IDs would be lost.
  if (!parsed.dryRun) await readProvisionState(context.rootDir)

  const { actions, checked, warnings } = await planProvision(provider, context, options, parsed.json)
  // A step that could not look up its resources planned nothing for them, so applying would report success for an incomplete plan.
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

  // apply() is idempotent: it skips creation when the resource exists but still returns its ids.
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
      stateFile: wroteState ? PROVISION_STATE_FILE : null,
      warnings,
    })}\n`)
  }
  else if (wroteState) {
    context.stdout.write(`provision: wrote ids to ${PROVISION_STATE_FILE}\n`)
  }
  return blocked ? 1 : 0
}

async function runProvisionStatus(args: string[], cliContext: ProvisionFeatureContext, options: ProvisionFeatureOptions): Promise<number> {
  const parsed = parseArgs("status", args)
  const resolved = resolveHost("status", parsed, cliContext)
  if ("exitCode" in resolved) return resolved.exitCode
  const { host: provider } = resolved
  const context = await withHostCredentials(provider, cliContext)

  const recorded = (await readProvisionState(context.rootDir))[provider] ?? {}
  const undeclared = findUndeclaredEntries(provider, recorded, await options.collectSteps(), context.env)
  const hasCredentials = hasHostCredentials(provider, context.env)
  const { actions, checked, warnings } = hasCredentials
    ? await planProvision(provider, context, options, parsed.json)
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
      stateFile: PROVISION_STATE_FILE,
      undeclared,
      warnings,
    })}\n`)
    return 0
  }

  const isUndeclared = (category: string, key: string) => undeclared.some(entry => entry.category === category && entry.key === key)
  const recordedEntries = Object.entries(recorded)
    .flatMap(([category, ids]) => Object.entries(ids).map(([key, id]) => `${category}\t${key}\t${id}${isUndeclared(category, key) ? "\tnot declared" : ""}\n`))
  if (recordedEntries.length) {
    context.stdout.write(`recorded ${provider} ids (${PROVISION_STATE_FILE}):\n`)
    for (const entry of recordedEntries) context.stdout.write(entry)
    for (const entry of undeclared) context.stdout.write(`fix: ${entry.category} ${JSON.stringify(entry.key)}: ${entry.fix}\n`)
  }
  else {
    context.stdout.write(`recorded ${provider} ids: none in ${PROVISION_STATE_FILE}\n`)
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

/** Built-in namespace that orchestrates package-contributed Provision Steps. */
export function createProvisionNamespace(steps: readonly ProvisionStep[]): ViteHubCliCommandNamespace {
  const options: ProvisionFeatureOptions = { collectSteps: async () => [...steps] }
  return {
    description: "Idempotently create missing provider resources.",
    features: [{
      description: "Create missing provider resources for the app's Definitions.",
      name: "run",
      run: (args, context) => runProvision(args, context, options),
      usage: USAGE.run,
    }, {
      description: "Show recorded provider ids and pending plan actions.",
      name: "status",
      run: (args, context) => runProvisionStatus(args, context, options),
      usage: USAGE.status,
    }],
    name: "provision",
  }
}
