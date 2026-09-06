import { hasRuntimeType } from "./internal/runtime-type.ts"
import type {
  AgentHookObserver,
  AgentHookObserverEvent,
  AgentHookObserverHooks,
  MaybePromise,
} from "./types.ts"
import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"

function observerList(hooks?: AgentHookObserverHooks): AgentHookObserver[] {
  const observers = hooks?.["hook:observe"]
  if (!observers) return []
  return hasRuntimeType(observers, "function") ? [observers] : [...observers]
}

function errorMetadata(error: unknown): AgentHookObserverEvent["error"] {
  return normalizeRuntimeDiagnosticError(error, { maxDepth: 4, maxErrors: 8, maxStringLength: 512 })
}

export async function notifyAgentHookObservers(
  hooks: AgentHookObserverHooks | undefined,
  event: AgentHookObserverEvent,
): Promise<void> {
  for (const observe of observerList(hooks)) {
    try {
      await observe(Object.freeze({ ...event }))
    }
    catch (error) {
      console.warn("[vitehub] Hook observer failed.", error)
    }
  }
}

export async function runObservedAgentHook<T>(
  hooks: AgentHookObserverHooks | undefined,
  event: Omit<AgentHookObserverEvent, "durationMs" | "error" | "outcome">,
  run: () => MaybePromise<T>,
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await run()
    await notifyAgentHookObservers(hooks, {
      ...event,
      durationMs: Date.now() - startedAt,
      outcome: "success",
    })
    return result
  }
  catch (error) {
    await notifyAgentHookObservers(hooks, {
      ...event,
      durationMs: Date.now() - startedAt,
      error: errorMetadata(error),
      outcome: "error",
    })
    throw error
  }
}
