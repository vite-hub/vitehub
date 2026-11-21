import { invariantError } from "@vite-hub/internal/invariant"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { startAiEmulator, upstreamMessage } from "../internal/ai-emulator.ts"

import type { AiEmulator } from "../internal/ai-emulator.ts"
import type { AiConfig, AiSeedConfig, CallRecord, DefaultKind, RuleSnapshot } from "@emulators/ai"

/** One scripted rule of the AI emulator, typed by upstream `@emulators/ai`. */
export type EmulatedModelRule = NonNullable<AiSeedConfig["rules"]>[number]

/** The `ai` seed of the AI emulator. `strict` defaults to `true`. */
export type EmulatedModelSeed = Omit<AiSeedConfig, "baseUrl" | "port">

/** The active configuration of the AI emulator, with the budget that each rule has left (`null` is unlimited). */
export interface EmulatedModelRules extends Omit<AiConfig, "rules"> {
  rules: Array<AiConfig["rules"][number] & { remaining: number | null }>
}

/** One recorded model request. `matched.id` is the rule that answered; it is `undefined` when a default answered. */
export interface EmulatedModelCall extends Omit<CallRecord, "matched"> {
  /** The rule that answered, the default that answered, or `null` when strict mode rejected the request. */
  matched: RuleSnapshot | { default: DefaultKind, id?: undefined } | null
}

/** A running AI emulator. `await using` closes it. */
export interface EmulatedModels extends AsyncDisposable {
  /** Origin of the emulator, such as `http://127.0.0.1:41234`. It is also in `VITEHUB_EMULATE_URL`. */
  readonly url: string
  /** Returns the active rules and settings. */
  rules: () => Promise<EmulatedModelRules>
  /** Replaces the rules and restores their `times` budgets. The other seed settings, such as `strict`, stay. */
  setRules: (rules: EmulatedModelRule[]) => Promise<EmulatedModelRules>
  /** Returns the recorded model requests, oldest first. `matched.id` is the rule that answered. */
  calls: () => Promise<EmulatedModelCall[]>
  /** Restores the seeded rules and budgets, and clears the calls and stored responses. */
  reset: () => Promise<void>
  /** Stops the emulator and restores `VITEHUB_EMULATE_URL` and `VITEHUB_MODELS`. */
  close: () => Promise<void>
}

const envNames = ["VITEHUB_EMULATE_URL", "VITEHUB_MODELS"] as const
const activeScope = Symbol.for("vitehub.agent.emulateModels.active")
const worker = process as typeof process & { [activeScope]?: true }

/**
 * Starts the upstream AI emulator (`@emulators/ai`) on a free loopback port for a test. Model requests get answers from
 * scripted rules, with no AI key. It sets `VITEHUB_EMULATE_URL` and `VITEHUB_MODELS=emulate` until it closes.
 * Strict mode is on by default, so a request that no rule matches fails with the missing rule as YAML.
 * Only one scope per test worker can be active at a time.
 */
export async function emulateModels(seed: EmulatedModelSeed = {}): Promise<EmulatedModels> {
  if (worker[activeScope]) throw agentDiagnostics.AGENT_EMULATOR_SCOPE_ACTIVE()
  worker[activeScope] = true
  let config: EmulatedModelSeed
  let emulator: AiEmulator
  try {
    config = { ...seed, strict: seed.strict ?? true }
    emulator = await startAiEmulator(config)
  }
  catch (error) {
    delete worker[activeScope]
    throw error
  }
  const url = emulator.url
  const previous = envNames.map(name => [name, process.env[name]] as const)
  process.env.VITEHUB_EMULATE_URL = url
  process.env.VITEHUB_MODELS = "emulate"
  let closing: Promise<void> | undefined

  async function request(path: string, init?: RequestInit): Promise<Response> {
    if (closing) throw agentDiagnostics.AGENT_EMULATOR_CLOSED()
    const response = await fetch(`${url}${path}`, init)
    if (response.ok) return response
    const detail = await response.text()
    if (response.status === 400 && path === "/_ai/rules") throw agentDiagnostics.AGENT_EMULATOR_RULES_INVALID({ detail: upstreamMessage(detail) })
    throw invariantError(`AI emulator ${init?.method ?? "GET"} ${path} answered ${response.status}: ${detail}`)
  }

  const close = (): Promise<void> => closing ??= (async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    try {
      await emulator.close()
    }
    finally {
      delete worker[activeScope]
    }
  })()

  return {
    url,
    rules: async () => await (await request("/_ai/rules")).json() as EmulatedModelRules,
    setRules: async rules => await (await request("/_ai/rules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...config, rules }),
    })).json() as EmulatedModelRules,
    calls: async () => await (await request("/_ai/calls")).json() as EmulatedModelCall[],
    reset: async () => {
      await request("/_ai/reset", { method: "POST" })
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
