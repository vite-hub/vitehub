import { mergeProvisionState, writeProvisionState } from "@vite-hub/internal/provision-state"
import { resolveCloudflareProvisionConfig, resolveVercelProvisionConfig } from "@vite-hub/internal/provision"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type {
  ProvisionAction,
  ProvisionContext,
  ProvisionState,
  ProvisionStep,
} from "@vite-hub/internal/provision"

type ProvisionFeatureContext = Pick<ViteHubCliContext, "env" | "rootDir" | "stderr" | "stdout">

interface ProvisionFeatureOptions {
  collectSteps: () => Promise<ProvisionStep[]>
}

interface ParsedProvisionArgs {
  dryRun: boolean
  error?: string
  help: boolean
  provider?: string
}

function parseArgs(args: string[]): ParsedProvisionArgs {
  const parsed: ParsedProvisionArgs = { dryRun: false, help: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--dry-run") parsed.dryRun = true
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

function writeUsage(stream: ProvisionFeatureContext["stdout"]): void {
  stream.write([
    "Usage: vitehub provision run --provider <cloudflare|vercel> [--dry-run]",
    "",
    "Idempotently creates missing provider resources for the app's Definitions.",
    "Never deletes or mutates existing resources.",
    "",
    "Options:",
    "  --provider <name>  Target provider: cloudflare or vercel (required).",
    "  --dry-run          Print the plan without applying it.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

export async function runProvision(args: string[], context: ProvisionFeatureContext, options: ProvisionFeatureOptions): Promise<number> {
  const parsed = parseArgs(args)
  if (parsed.help) {
    writeUsage(context.stdout)
    return 0
  }
  if (parsed.error) {
    context.stderr.write(`${parsed.error}\n`)
    writeUsage(context.stderr)
    return 1
  }
  if (parsed.provider !== "cloudflare" && parsed.provider !== "vercel") {
    context.stderr.write("Provision requires --provider cloudflare|vercel.\n")
    writeUsage(context.stderr)
    return 1
  }

  const provider = parsed.provider
  // Fail closed outside --dry-run: a credential-less run silently creating
  // nothing would mask missing CI secrets behind a green step.
  if (!parsed.dryRun) {
    const config = provider === "cloudflare"
      ? resolveCloudflareProvisionConfig(context.env)
      : resolveVercelProvisionConfig(context.env)
    if (!config) {
      const required = provider === "cloudflare" ? "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN" : "VERCEL_TOKEN"
      context.stderr.write(`Provision requires ${required} to be set. Dry-run preview does not require credentials (--dry-run).\n`)
      return 1
    }
  }
  const steps = (await options.collectSteps()).filter(step => step.provider === provider)
  const provisionContext: ProvisionContext = {
    env: context.env,
    fetch: globalThis.fetch,
    logger: {
      log: message => context.stdout.write(`${message}\n`),
      warn: message => context.stderr.write(`${message}\n`),
    },
  }

  const actions: Array<{ stepId: string, action: ProvisionAction }> = []
  for (const step of steps) {
    for (const action of await step.plan(provisionContext)) {
      actions.push({ stepId: step.id, action })
    }
  }

  if (!actions.length) {
    context.stdout.write(`provision: no ${provider} resources to create.\n`)
    return 0
  }

  for (const { action } of actions) {
    context.stdout.write(`${action.exists ? "exists" : "create"}\t${action.kind}\t${action.name}\n`)
  }

  if (parsed.dryRun) return 0

  // apply() is idempotent: it skips creation when the resource exists but still returns its ids.
  let state: ProvisionState = {}
  for (const { action } of actions) {
    const result = await action.apply()
    if (result.ids) state = mergeProvisionState(state, result.ids)
  }

  if (Object.keys(state).length) {
    await writeProvisionState(context.rootDir, state)
    context.stdout.write(`provision: wrote ids to .vitehub/provision.json\n`)
  }

  return 0
}
