import process from "node:process"
import { createInterface } from "node:readline/promises"

import { planProvisionSteps } from "@vite-hub/internal/provision"
import { mergeProvisionState, PROVISION_STATE_FILE, readProvisionState, writeProvisionState } from "@vite-hub/internal/provision-state"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { isProvisionHost, provisionActionStatus, provisionEnv, writeProvisionActions } from "../../provision.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { HostCredentials } from "@vite-hub/internal/host-credentials"
import type { ProvisionProvider, ProvisionState, ProvisionStep } from "@vite-hub/internal/provision"
import type { ProvisionActionStatus } from "../../provision.ts"
import type { SetupLink } from "../link.ts"
import type { DeployHost } from "./host.ts"

/** What `vitehub deploy --json` reports in `provision`. */
export interface DeployProvisionOutput {
  /** The resources that this deploy created or changed. Empty when everything existed. */
  changed: Array<{ status: Exclude<ProvisionActionStatus, "exists">, kind: string, name: string, step: string }>
  /** The ids of the host resources, by category and key, as `.vitehub/provision.json` records them. */
  ids: Record<string, Record<string, string>>
}

export interface DeployProvisionInput {
  host: DeployHost
  credentials: HostCredentials
  link: SetupLink | undefined
  build: boolean
  json: boolean
  yes: boolean
  /** The deploy command with --no-provision, for the fix line. */
  rerun: string
}

/** A step whose recorded state declares nothing has no resource to create, so deploy does not ask the host. */
function declaresResources(step: ProvisionStep, env: NodeJS.ProcessEnv): boolean {
  const described = step.recordedState?.({ env })
  return described === undefined || described.some(category => category.declared.length > 0)
}

function uncheckedFix(host: ProvisionProvider, env: NodeJS.ProcessEnv, rerun: string): string {
  const skip = ` Or skip it: run \`${rerun}\`.`
  if (host === "cloudflare" && !env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    return `Set CLOUDFLARE_ACCOUNT_ID, or run \`vitehub link --host cloudflare --account <id>\`. A \`wrangler login\` with several accounts does not say which one to use.${skip}`
  }
  if (host === "vercel" && !env.VERCEL_TOKEN?.trim()) {
    return `A saved \`vercel login\` cannot create Vercel resources. Set VERCEL_TOKEN to a token from https://vercel.com/account/tokens.${skip}`
  }
  if (host === "vercel" && !env.VERCEL_PROJECT_ID?.trim()) {
    return `Run \`vitehub link --host vercel\` to store the project id, or set VERCEL_PROJECT_ID.${skip}`
  }
  return `Fix the cause of the warnings.${skip}`
}

async function confirmProvision(count: number, host: DeployHost): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/iu.test((await terminal.question(`Create or change ${count} ${count === 1 ? "resource" : "resources"} on ${host}? [y/N] `)).trim())
  }
  finally {
    terminal.close()
  }
}

/**
 * Runs the Provision Steps of `host` before the build, with the credentials that deploy resolved, such as a
 * `wrangler login`. It creates missing resources and records their ids in `.vitehub/provision.json`, so the build
 * binds them and a second deploy creates nothing. Returns undefined when the host has no step with a resource.
 */
export async function provisionForDeploy(input: DeployProvisionInput, context: ViteHubCliContext): Promise<DeployProvisionOutput | undefined> {
  const { host } = input
  if (!isProvisionHost(host) || !context.loadProvision) return
  const env = provisionEnv(context.env, input.credentials, {
    ...(input.link?.account?.id ? { accountId: input.link.account.id } : {}),
    ...(input.link?.project.id ? { projectId: input.link.project.id } : {}),
  })
  const loaded = await context.loadProvision(host)
  const steps = loaded.steps.filter(step => step.provider === host && declaresResources(step, env))
  if (!steps.length) return
  // The build reads the ids from the config root, which is the project root unless the config moves it.
  const root = loaded.rootDir
  // An unreadable state file would lose the ids of the resources that this deploy creates.
  await readProvisionState(root)

  const plan = await planProvisionSteps(host, steps, {
    env,
    fetch: context.fetch ?? globalThis.fetch,
    logger: {
      log: message => context.stderr.write(`${message}\n`),
      warn: message => context.stderr.write(`${message}\n`),
    },
  })
  if (!plan.checked) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_PROVISION_UNCHECKED({ fix: uncheckedFix(host, env, input.rerun), host, warnings: plan.warnings.join(" ") }), setupExitCodes.inputNeeded, { rerun: input.rerun })
  }

  const changes = plan.actions.flatMap((planned) => {
    const status = provisionActionStatus(planned)
    return status === "exists" ? [] : [{ planned, status }]
  })
  if (changes.length && !input.build) {
    throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_PROVISION_NEEDS_BUILD({ count: changes.length, host }), setupExitCodes.conflict)
  }
  if (changes.length) {
    if (!input.json) {
      context.stdout.write(`Provision on ${host}:\n`)
      writeProvisionActions(changes.map(change => change.planned), context.stdout)
    }
    // The deploy question already ran, so without --yes this is a terminal.
    if (!input.yes && !await confirmProvision(changes.length, host)) {
      throw new SetupFailure(cliErrorDiagnostics.CLI_R0004({ message: "[vitehub] The resources were not confirmed. Nothing was created or deployed." }), setupExitCodes.error)
    }
  }

  // apply() of an existing resource creates nothing and returns its ids, so the state file stays complete.
  let state: ProvisionState = {}
  try {
    for (const { action } of plan.actions) {
      const result = await action.apply()
      if (result.ids) state = mergeProvisionState(state, result.ids)
    }
  }
  finally {
    if (Object.keys(state).length) await writeProvisionState(root, state)
  }
  if (changes.length && !input.json) context.stdout.write(`Provisioned ${changes.length} ${changes.length === 1 ? "resource" : "resources"} on ${host}. Ids are in ${PROVISION_STATE_FILE}.\n`)

  return {
    changed: changes.map(({ planned, status }) => ({ kind: planned.action.kind, name: planned.action.name, status, step: planned.step })),
    ids: state[host] ?? {},
  }
}
