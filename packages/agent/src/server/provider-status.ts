import { createExecutionContext } from "@vite-hub/runtime"

import type { AgentInput, AgentProviderStatus, AgentRuntimeContext } from "../types.ts"

/** A definition owns its account. Cache by definition identity, never by provider name. */
export function createAgentStatusReader(options: { maxAgeMs?: number, timeoutMs?: number } = {}): (agent: AgentInput, name: string) => Promise<AgentProviderStatus> {
  const states = new WeakMap<AgentInput, { value?: AgentProviderStatus, expiresAt: number, pending?: Promise<AgentProviderStatus> }>()
  return (agent: AgentInput, name: string): Promise<AgentProviderStatus> => {
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
