import { createExecutionContext } from "@vite-hub/runtime"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { agentSettings } from "../composition.ts"
import { languageModelRoute, modelEmulatorUrl, resolveModelEmulation } from "../internal/agent-emulation.ts"
import { normalizeAgentDriver } from "../internal/agent-driver.ts"
import type { NormalizedAgentDriver } from "../internal/agent-driver.ts"
import { gatewayModelDescriptor } from "../internal/agent-model.ts"
import { withProviderStatusError } from "../internal/provider-status-error.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"

import type { AgentInput, AgentModelInput, AgentProviderStatus, AgentRuntimeContext, AgentSettings } from "../types.ts"

/** How an Agent runs under `VITEHUB_MODELS=emulate`, from its definition alone. */
type EmulationVerdict =
  | { kind: "emulated" }
  | { kind: "fails", error: Error }
  | { kind: "unknown", reason: string }

/**
 * The number of Capability tools that a Codex run gets, or undefined when only a run can tell. Capabilities that resolve
 * their tools or CLI at run time, a Capability resolver, Channels, and a Workspace can all add tools.
 */
function staticCapabilityToolCount(settings: AgentSettings): number | undefined {
  // SAFETY: AgentSettings is an object contract. This reads only the optional fields that can add tools.
  const record = settings as unknown as Record<string, unknown>
  if (record.channels !== undefined || record.workspace !== undefined) return
  const capabilities = record.capabilities
  if (capabilities === undefined) return 0
  if (!Array.isArray(capabilities)) return
  let count = 0
  for (const capability of capabilities) {
    if (!isRuntimeRecord(capability)) return
    if (typeof capability.tools === "function" || typeof capability.cli === "function") return
    if (isRuntimeRecord(capability.tools)) count += Object.keys(capability.tools).length
    if (isRuntimeRecord(capability.cli)) count += 1
  }
  return count
}

/**
 * Whether an Agent runs on the AI emulator, with the same rules that a run applies before it reads a credential. It
 * reads only the definition, so it calls no resolver and reads no credential.
 */
function emulationVerdict(settings: AgentSettings | undefined, driver: NormalizedAgentDriver | undefined): EmulationVerdict {
  if (!settings || !driver) return { kind: "unknown", reason: "The Agent has no Driver that inspection can read." }
  if (driver.kind === "ask") return { kind: "fails", error: agentDiagnostics.AGENT_MODELS_EMULATE_ASK_UNSUPPORTED() }
  if (driver.kind === "run") return { kind: "unknown", reason: "A run Driver calls its own code, so inspection cannot tell whether it uses the AI emulator." }
  if (driver.kind === "external") return { kind: "unknown", reason: "An external Driver runs outside the app, so inspection cannot tell whether it uses the AI emulator." }
  if (driver.kind === "model") {
    if (driver.gateway || typeof driver.model === "string") return { kind: "emulated" }
    if (typeof driver.model === "function") return { kind: "unknown", reason: "The model resolver runs only in an Invocation, so inspection cannot tell whether its model can use the AI emulator." }
    if (languageModelRoute(driver.model) || gatewayModelDescriptor(driver.model as AgentModelInput)) return { kind: "emulated" }
    const provider: unknown = isRuntimeRecord(driver.model) ? driver.model.provider : undefined
    return { kind: "fails", error: agentDiagnostics.AGENT_MODELS_EMULATE_MODEL_UNSUPPORTED({ provider: typeof provider === "string" && provider ? provider : "unknown" }) }
  }
  if (driver.provider === "claude-code") return { kind: "fails", error: agentDiagnostics.AGENT_MODELS_EMULATE_CLAUDE_CODE_UNSUPPORTED() }
  const tools = staticCapabilityToolCount(settings)
  if (tools) return { kind: "fails", error: agentDiagnostics.AGENT_MODELS_EMULATE_CODEX_TOOLS_UNSUPPORTED({ tools }) }
  // SAFETY: AgentSettings is an object contract. `sandbox` is an optional field of it.
  if ((settings as unknown as Record<string, unknown>).sandbox !== undefined) return { kind: "fails", error: agentDiagnostics.AGENT_MODELS_EMULATE_SANDBOX_UNSUPPORTED() }
  if (tools === undefined) return { kind: "unknown", reason: "Codex runs on the AI emulator only without Capability tools, and this Agent gets its tools only in an Invocation." }
  return { kind: "emulated" }
}

/**
 * The status of an Agent under `VITEHUB_MODELS=emulate`, or undefined when the switch is off. It reads no credentials
 * and does not call `agent.status()`. Only an Agent whose Driver runs on the emulator is `ready` and `emulated`. An
 * Agent that a run rejects is `unavailable` with the code of that rejection. An Agent that inspection cannot judge
 * from its definition is `unknown`.
 */
function emulatedStatus(agent: AgentInput, name: string): AgentProviderStatus | undefined {
  const url = modelEmulatorUrl()
  if (!url) return
  const settings = agentSettings(agent)
  const driver = settings && normalizeAgentDriver(settings)
  const base = { agent: name, checkedAt: new Date().toISOString(), ...(driver?.kind === "provider" ? { provider: driver.provider } : {}), stale: false }
  let verdict: EmulationVerdict
  try {
    resolveModelEmulation()
    verdict = emulationVerdict(settings, driver)
  }
  catch (error) {
    if (!(error instanceof Error)) throw error
    verdict = { kind: "fails", error }
  }
  if (verdict.kind === "emulated") return { ...base, emulated: { url }, readiness: "ready" }
  if (verdict.kind === "unknown") return { ...base, readiness: "unknown", reason: verdict.reason }
  const code: unknown = Reflect.get(verdict.error, "code")
  return withProviderStatusError({ ...base, ...(typeof code === "string" ? { code } : {}), readiness: "unavailable", reason: verdict.error.message }, verdict.error)
}

/** A definition owns its account. Cache by definition identity, never by provider name. */
export function createAgentStatusReader(options: { maxAgeMs?: number, timeoutMs?: number } = {}): (agent: AgentInput, name: string) => Promise<AgentProviderStatus> {
  const states = new WeakMap<AgentInput, { value?: AgentProviderStatus, expiresAt: number, pending?: Promise<AgentProviderStatus> }>()
  return (agent: AgentInput, name: string): Promise<AgentProviderStatus> => {
    const emulated = emulatedStatus(agent, name)
    if (emulated) return Promise.resolve(emulated)
    const now = Date.now()
    let state = states.get(agent)
    if (!state) { state = { expiresAt: 0 }; states.set(agent, state) }
    if (state.pending) return state.pending
    if (state.value && state.expiresAt > now) return Promise.resolve(state.value)
    const entry = state
    const controller = new AbortController()
    const memoValues = new Map<string, unknown>()
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Provider inspection timed out."))
        reject(controller.signal.reason)
      }, options.timeoutMs ?? 15_000)
    })
    const probe = agent.status ? Promise.resolve().then(() => agent.status!(createExecutionContext<AgentRuntimeContext>({
      agentIdentity: { name },
      memo(key, create) {
        if (!memoValues.has(key)) memoValues.set(key, create())
        // SAFETY: Each memo key returns the value created for that same generic call site.
        return memoValues.get(key) as never
      },
      runtime: "unknown" as const,
      runtimeConfig: {},
      waitUntil: task => void task.catch(() => {}),
    }), { abortSignal: controller.signal })) : Promise.resolve<AgentProviderStatus>({
      agent: name, checkedAt: new Date(now).toISOString(), readiness: "unsupported", stale: false,
    })
    entry.pending = Promise.race([probe, timeout]).catch((): AgentProviderStatus => ({
      ...entry.value,
      agent: name, checkedAt: entry.value?.checkedAt ?? new Date().toISOString(),
      readiness: "unknown", stale: Boolean(entry.value),
      reason: controller.signal.aborted ? "Provider inspection timed out." : "Provider inspection failed.",
    })).then(value => {
      entry.value = value
      entry.expiresAt = Date.now() + (options.maxAgeMs ?? 30_000)
      return value
    }).finally(() => {
      clearTimeout(timer)
      // A timed-out probe can still be cleaning up. Do not launch another until it settles.
      void probe.finally(() => { entry.pending = undefined }).catch(() => undefined)
    })
    return entry.pending
  }
}
