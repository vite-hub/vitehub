import type { AgentRunInput } from "./types.ts"

export type AgentInvocationStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

export interface AgentInvocationSnapshot<TOutput = unknown> {
  error?: unknown
  id: string
  output?: TOutput
  status: AgentInvocationStatus
}

export type AgentInvocationInspection<TOutput = unknown> =
  | { invocation: AgentInvocationSnapshot<TOutput>, outcome: "available" }
  | { id: string, outcome: "unavailable" }

export type AgentInvocationControlOutcome = "accepted" | "unsupported" | "unavailable" | "invalid-state"

export interface AgentInvocationControlResult<TOutput = unknown> {
  id: string
  invocation?: AgentInvocationSnapshot<TOutput>
  outcome: AgentInvocationControlOutcome
}

export type AgentInvocationInputMode = "follow-up" | "steer"

export interface AgentInvocationInputSupport {
  followUp: boolean
  steer: boolean
}

export interface AgentInvocationController<
  TOutput = unknown,
  CALL_OPTIONS = unknown,
> {
  cancel: (reason?: unknown) => Promise<AgentInvocationControlResult<TOutput>>
  id: string
  inspect: () => Promise<AgentInvocationInspection<TOutput>>
  sendInput: (
    input: AgentRunInput<CALL_OPTIONS>,
    options: { mode: AgentInvocationInputMode },
  ) => Promise<AgentInvocationControlResult<TOutput>>
  support: AgentInvocationInputSupport
}

export interface AgentInvocationControllerAdapter<
  TOutput = unknown,
  CALL_OPTIONS = unknown,
> {
  cancel: (reason?: unknown) => Promise<AgentInvocationControlResult<TOutput>>
  inspect: () => Promise<AgentInvocationInspection<TOutput>>
  sendInput?: (
    input: AgentRunInput<CALL_OPTIONS>,
    options: { mode: AgentInvocationInputMode },
  ) => Promise<AgentInvocationControlResult<TOutput>>
  support?: Partial<AgentInvocationInputSupport>
}

export type AgentInvocationFinishOutcome<TOutput = unknown> =
  | { output?: TOutput, status: "completed" }
  | { error: unknown, status: "failed" }

export interface LiveAgentInvocationOptions<TOutput = unknown> {
  parentAbortSignal?: AbortSignal
  start: (context: {
    abortSignal: AbortSignal
    id: string
    onFinish: (outcome: AgentInvocationFinishOutcome<TOutput>) => void
  }) => Promise<unknown>
}

export interface BackedAgentInvocationOptions<TOutput = unknown> {
  cancel: () => Promise<AgentInvocationSnapshot<TOutput> | undefined>
  errorOutcome: (error: unknown) => "unsupported" | "unavailable"
  id: string
  inspect: () => Promise<AgentInvocationSnapshot<TOutput> | undefined>
  parentAbortSignal?: AbortSignal
  result: Promise<unknown>
}

const agentInvocationResult = Symbol.for("vitehub.agentInvocationResult")

type InternalAgentInvocationController = AgentInvocationController & {
  [agentInvocationResult]: Promise<unknown>
}

export function createAgentInvocationController<
  TOutput = unknown,
  CALL_OPTIONS = unknown,
>(
  id: string,
  adapter: AgentInvocationControllerAdapter<TOutput, CALL_OPTIONS>,
  result: Promise<unknown>,
): AgentInvocationController<TOutput, CALL_OPTIONS> {
  const support: AgentInvocationInputSupport = Object.freeze({
    followUp: adapter.support?.followUp === true,
    steer: adapter.support?.steer === true,
  })
  const controller = {
    cancel: adapter.cancel,
    id,
    inspect: adapter.inspect,
    sendInput: adapter.sendInput || (async () => ({ id, outcome: "unsupported" })),
    support,
  }
  Object.defineProperty(controller, agentInvocationResult, { value: result })
  return Object.freeze(controller)
}

export function awaitAgentInvocationResult(controller: AgentInvocationController): Promise<unknown> {
  return (controller as InternalAgentInvocationController)[agentInvocationResult]
}

function randomAgentInvocationId(): string {
  return `ainv_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`
}

function isTerminalAgentInvocationStatus(status: AgentInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

export function startLiveAgentInvocation<TOutput = unknown, CALL_OPTIONS = unknown>(
  options: LiveAgentInvocationOptions<TOutput>,
): AgentInvocationController<TOutput, CALL_OPTIONS> {
  const id = randomAgentInvocationId()
  const abortController = new AbortController()
  const abortSignal = options.parentAbortSignal
    ? AbortSignal.any([options.parentAbortSignal, abortController.signal])
    : abortController.signal
  let snapshot: AgentInvocationSnapshot<TOutput> = { id, status: "running" }
  let observedFinish = false
  const result = options.start({
    abortSignal,
    id,
    onFinish(outcome) {
      observedFinish = true
      snapshot = outcome.status === "completed"
        ? { id, ...(outcome.output !== undefined ? { output: outcome.output } : {}), status: "completed" }
        : abortSignal.aborted
          ? { id, status: "cancelled" }
          : { error: outcome.error, id, status: "failed" }
    },
  })
  void result.catch((error) => {
    if (observedFinish) return
    snapshot = abortSignal.aborted
      ? { id, status: "cancelled" }
      : { error, id, status: "failed" }
  })
  return createAgentInvocationController<TOutput, CALL_OPTIONS>(id, {
    async cancel(reason) {
      if (isTerminalAgentInvocationStatus(snapshot.status)) {
        return { id, invocation: { ...snapshot }, outcome: "invalid-state" }
      }
      abortController.abort(reason)
      return { id, invocation: { ...snapshot }, outcome: "accepted" }
    },
    async inspect() {
      return { invocation: { ...snapshot }, outcome: "available" }
    },
    async sendInput() {
      return { id, invocation: { ...snapshot }, outcome: "unsupported" }
    },
  }, result)
}

export function createBackedAgentInvocationController<TOutput = unknown, CALL_OPTIONS = unknown>(
  options: BackedAgentInvocationOptions<TOutput>,
): AgentInvocationController<TOutput, CALL_OPTIONS> {
  let removeParentAbortListener: (() => void) | undefined
  const observeTerminalSnapshot = (snapshot: AgentInvocationSnapshot<TOutput> | undefined) => {
    if (snapshot && isTerminalAgentInvocationStatus(snapshot.status)) {
      removeParentAbortListener?.()
      removeParentAbortListener = undefined
    }
    return snapshot
  }
  const inspect = async (): Promise<AgentInvocationInspection<TOutput>> => {
    try {
      const snapshot = observeTerminalSnapshot(await options.inspect())
      return snapshot
        ? { invocation: snapshot, outcome: "available" }
        : { id: options.id, outcome: "unavailable" }
    }
    catch {
      return { id: options.id, outcome: "unavailable" }
    }
  }
  const controller = createAgentInvocationController<TOutput, CALL_OPTIONS>(options.id, {
    async cancel() {
      try {
        const snapshot = observeTerminalSnapshot(await options.cancel())
        if (!snapshot) return { id: options.id, outcome: "unavailable" }
        return {
          id: options.id,
          invocation: snapshot,
          outcome: isTerminalAgentInvocationStatus(snapshot.status) && snapshot.status !== "cancelled"
            ? "invalid-state"
            : "accepted",
        }
      }
      catch (error) {
        return { id: options.id, outcome: options.errorOutcome(error) }
      }
    },
    inspect,
    async sendInput() {
      return { id: options.id, outcome: "unsupported" }
    },
  }, options.result)
  if (options.parentAbortSignal) {
    const parentAbortSignal = options.parentAbortSignal
    const cancel = () => void controller.cancel(parentAbortSignal.reason)
    if (options.parentAbortSignal.aborted) cancel()
    else {
      parentAbortSignal.addEventListener("abort", cancel, { once: true })
      removeParentAbortListener = () => parentAbortSignal.removeEventListener("abort", cancel)
    }
  }
  return controller
}
