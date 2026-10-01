import { collectViteHubProvisionSteps } from "@vite-hub/internal/cli"
import { mergeProvisionState, PROVISION_STATE_FILE, readProvisionState, writeProvisionState } from "@vite-hub/internal/provision-state"
import { resolveCloudflareProvisionConfig, resolveVercelProvisionConfig } from "@vite-hub/internal/provision"

import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"
import type {
  ProvisionAction,
  ProvisionContext,
  ProvisionProvider,
  ProvisionState,
  ProvisionStep,
} from "@vite-hub/internal/provision"

type ProvisionFeatureContext = Pick<ViteHubCliContext, "env" | "rootDir" | "stderr" | "stdout">
type ProvisionCommand = "run" | "status"

interface ProvisionFeatureOptions {
  collectSteps: () => Promise<ProvisionStep[]>
}

interface ParsedProvisionArgs {
  dryRun: boolean
  error?: string
  help: boolean
  json: boolean
  provider?: string
}

interface PlannedProvisionAction {
  action: ProvisionAction
  step: string
}

interface ProvisionPlan {
  actions: PlannedProvisionAction[]
  checked: boolean
  warnings: string[]
}

const PROVISION_PROVIDERS = ["cloudflare", "vercel"] as const satisfies readonly ProvisionProvider[]
const PROVIDER_CREDENTIALS = {
  cloudflare: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN",
  vercel: "VERCEL_TOKEN",
} as const satisfies Record<ProvisionProvider, string>
const USAGE = {
  run: "vitehub provision run --provider <cloudflare|vercel> [--dry-run] [--json]",
  status: "vitehub provision status --provider <cloudflare|vercel> [--json]",
} as const satisfies Record<ProvisionCommand, string>

function isProvisionProvider(value: string | undefined): value is ProvisionProvider {
  return PROVISION_PROVIDERS.some(provider => provider === value)
}

function parseArgs(command: ProvisionCommand, args: string[]): ParsedProvisionArgs {
  const parsed: ParsedProvisionArgs = { dryRun: false, help: false, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (arg === "--dry-run" && command === "run") parsed.dryRun = true
    else if (arg === "--provider") {
      const provider = args[index + 1]
      if (!provider || provider.startsWith("-")) parsed.error = "Option --provider requires a value."
      else {
        parsed.provider = provider
        index++
      }
    }
    else if (arg?.startsWith("--provider=")) {
      const provider = arg.slice("--provider=".length)
      if (!provider) parsed.error = "Option --provider requires a value."
      else parsed.provider = provider
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
        "Idempotently creates missing provider resources for the app's Definitions.",
        "Never deletes or mutates existing resources.",
        "",
        "Options:",
        "  --provider <name>  Target provider: cloudflare or vercel (required).",
        "  --dry-run          Print the plan without applying it.",
        "  --json             Print one JSON result to stdout.",
        "  -h, --help         Show this help.",
      ]
    : [
        `Usage: ${USAGE.status}`,
        "",
        "Shows the ids recorded in .vitehub/provision.json and the actions the current plan would apply.",
        "Never creates provider resources or writes Provision State.",
        "",
        "Options:",
        "  --provider <name>  Target provider: cloudflare or vercel (required).",
        "  --json             Print one JSON result to stdout.",
        "  -h, --help         Show this help.",
      ]
  stream.write(`${lines.join("\n")}\n\n`)
}

// Resolves the arguments shared by every provision command. Returns an exit code on failure or help.
function resolveProvider(command: ProvisionCommand, parsed: ParsedProvisionArgs, context: ProvisionFeatureContext): { exitCode: number } | { provider: ProvisionProvider } {
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return { exitCode: 0 }
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\n`)
    writeUsage(command, context.stderr)
    return { exitCode: 1 }
  }
  if (!isProvisionProvider(parsed.provider)) {
    context.stderr.write("Provision requires --provider cloudflare|vercel.\n")
    writeUsage(command, context.stderr)
    return { exitCode: 1 }
  }
  return { provider: parsed.provider }
}

function hasProviderCredentials(provider: ProvisionProvider, env: ProvisionFeatureContext["env"]): boolean {
  return Boolean(provider === "cloudflare" ? resolveCloudflareProvisionConfig(env) : resolveVercelProvisionConfig(env))
}

// Runs only the plan phase. Step messages go to stderr so stdout stays one JSON document in --json mode.
async function planProvision(provider: ProvisionProvider, context: ProvisionFeatureContext, options: ProvisionFeatureOptions, json: boolean): Promise<ProvisionPlan> {
  const warnings: string[] = []
  let checked = true
  const provisionContext: ProvisionContext = {
    env: context.env,
    fetch: globalThis.fetch,
    logger: {
      log: message => (json ? context.stderr : context.stdout).write(`${message}\n`),
      warn: (message) => {
        warnings.push(message)
        if (!json) context.stderr.write(`${message}\n`)
      },
    },
    markPlanUnchecked: () => { checked = false },
  }

  const actions: PlannedProvisionAction[] = []
  const steps = (await options.collectSteps()).filter(step => step.provider === provider)
  for (const step of steps) {
    for (const action of await step.plan(provisionContext)) {
      actions.push({ action, step: step.id })
    }
  }
  return { actions, checked, warnings }
}

function serializeAction({ action, step }: PlannedProvisionAction) {
  return {
    ...(action.pending === undefined ? {} : { pending: action.pending }),
    exists: action.exists,
    kind: action.kind,
    name: action.name,
    step,
  }
}

function writeActions(actions: PlannedProvisionAction[], stdout: ProvisionFeatureContext["stdout"]): void {
  for (const { action } of actions) {
    const status = !action.exists ? "create" : action.pending ? "pending" : "exists"
    stdout.write(`${status}\t${action.kind}\t${action.name}\n`)
  }
}

async function runProvision(args: string[], context: ProvisionFeatureContext, options: ProvisionFeatureOptions): Promise<number> {
  const parsed = parseArgs("run", args)
  const resolved = resolveProvider("run", parsed, context)
  if ("exitCode" in resolved) return resolved.exitCode
  const { provider } = resolved

  // Fail closed outside --dry-run: a credential-less run silently creating
  // nothing would mask missing CI secrets behind a green step.
  if (!parsed.dryRun && !hasProviderCredentials(provider, context.env)) {
    context.stderr.write(`Provision requires ${PROVIDER_CREDENTIALS[provider]} to be set. Dry-run preview does not require credentials (--dry-run).\n`)
    return 1
  }

  const { actions, warnings } = await planProvision(provider, context, options, parsed.json)
  if (!parsed.json) {
    if (!actions.length) {
      context.stdout.write(`provision: no ${provider} resources to create.\n`)
      return 0
    }
    writeActions(actions, context.stdout)
  }

  // apply() is idempotent: it skips creation when the resource exists but still returns its ids.
  let state: ProvisionState = {}
  if (!parsed.dryRun) {
    for (const { action } of actions) {
      const result = await action.apply()
      if (result.ids) state = mergeProvisionState(state, result.ids)
    }
  }
  const wroteState = Object.keys(state).length > 0
  if (wroteState) await writeProvisionState(context.rootDir, state)

  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({
      actions: actions.map(serializeAction),
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
  return 0
}

async function runProvisionStatus(args: string[], context: ProvisionFeatureContext, options: ProvisionFeatureOptions): Promise<number> {
  const parsed = parseArgs("status", args)
  const resolved = resolveProvider("status", parsed, context)
  if ("exitCode" in resolved) return resolved.exitCode
  const { provider } = resolved

  const recorded = (await readProvisionState(context.rootDir))[provider] ?? {}
  const hasCredentials = hasProviderCredentials(provider, context.env)
  const { actions, checked, warnings } = hasCredentials
    ? await planProvision(provider, context, options, parsed.json)
    : { actions: [], checked: false, warnings: [`provision: plan not checked, missing ${PROVIDER_CREDENTIALS[provider]}.`] }
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
      warnings,
    })}\n`)
    return 0
  }

  const recordedEntries = Object.entries(recorded)
    .flatMap(([category, ids]) => Object.entries(ids).map(([key, id]) => `${category}\t${key}\t${id}\n`))
  if (recordedEntries.length) {
    context.stdout.write(`recorded ${provider} ids (${PROVISION_STATE_FILE}):\n`)
    for (const entry of recordedEntries) context.stdout.write(entry)
  }
  else {
    context.stdout.write(`recorded ${provider} ids: none in ${PROVISION_STATE_FILE}\n`)
  }

  if (!checked) {
    if (!hasCredentials) context.stderr.write(`${warnings[0]}\n`)
    context.stdout.write("plan: not checked\n")
    return 0
  }
  writeActions(actions, context.stdout)
  context.stdout.write(pending
    ? `plan: ${pending} pending ${pending === 1 ? "action" : "actions"}. Run \`vitehub provision run --provider ${provider}\` to apply.\n`
    : "plan: no pending actions\n")
  return 0
}

/** Built-in namespace that orchestrates package-contributed Provision Steps. */
export function createProvisionNamespace(plugins: readonly unknown[]): ViteHubCliCommandNamespace {
  const options: ProvisionFeatureOptions = { collectSteps: () => collectViteHubProvisionSteps(plugins) }
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
