import { hasRuntimeType } from "./internal/runtime-type.ts"
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

export type AgentInvocationInputMode = "follow-up" | "respond" | "steer"

export interface AgentInvocationInputSupport {
  followUp: boolean
  respond: boolean
  steer: boolean
}

export interface AgentInvocationController<
  TOutput = unknown,
  CALL_OPTIONS = unknown,
  TResult = TOutput,
> {
  cancel: (reason?: unknown) => Promise<AgentInvocationControlResult<TOutput>>
  id: string
  inspect: () => Promise<AgentInvocationInspection<TOutput>>
  result: Promise<TResult>
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
  support?: Partial<AgentInvocationInputSupport> | (() => Partial<AgentInvocationInputSupport>)
}

export type AgentInvocationFinishOutcome<TOutput = unknown> =
  | { output?: TOutput, status: "completed" }
  | { error: unknown, status: "failed" }

export interface LiveAgentInvocationOptions<TOutput = unknown, CALL_OPTIONS = unknown, TResult = unknown> {
  parentAbortSignal?: AbortSignal
  sendInput?: (
    id: string,
    input: AgentRunInput<CALL_OPTIONS>,
    options: { mode: AgentInvocationInputMode },
  ) => Promise<AgentInvocationControlOutcome>
  start: (context: {
    abortSignal: AbortSignal
    id: string
    onFinish: (outcome: AgentInvocationFinishOutcome<TOutput>) => void
  }) => Promise<TResult>
  support?: (id: string) => Partial<AgentInvocationInputSupport>
}

export interface BackedAgentInvocationOptions<TOutput = unknown, TResult = unknown> {
  cancel: () => Promise<AgentInvocationSnapshot<TOutput> | undefined>
  errorOutcome: (error: unknown) => "unsupported" | "unavailable"
  id: string
  inspect: () => Promise<AgentInvocationSnapshot<TOutput> | undefined>
  parentAbortSignal?: AbortSignal
  result: () => Promise<TResult>
  startResult: Promise<unknown>
  settled?: Promise<unknown>
}

const agentInvocationStartResult = Symbol.for("vitehub.agentInvocationStartResult")

type InternalAgentInvocationController = AgentInvocationController & {
  [agentInvocationStartResult]: Promise<unknown>
}

export function createAgentInvocationController<
  TOutput = unknown,
  CALL_OPTIONS = unknown,
  TResult = unknown,
>(
  id: string,
  adapter: AgentInvocationControllerAdapter<TOutput, CALL_OPTIONS>,
  result: Promise<TResult> | (() => Promise<TResult>),
  startResult: Promise<unknown> = result as Promise<TResult>,
): AgentInvocationController<TOutput, CALL_OPTIONS, TResult> {
  const resolveSupport = () => hasRuntimeType(adapter.support, "function") ? adapter.support() : adapter.support
  const support: AgentInvocationInputSupport = Object.freeze({
    get followUp() {
      return resolveSupport()?.followUp === true
    },
    get respond() {
      return resolveSupport()?.respond === true
    },
    get steer() {
      return resolveSupport()?.steer === true
    },
  })
  const controller = {
    cancel: adapter.cancel,
    id,
    inspect: adapter.inspect,
    async sendInput(input: AgentRunInput<CALL_OPTIONS>, options: { mode: AgentInvocationInputMode }) {
      const supported = options.mode === "steer" ? support.steer : options.mode === "respond" ? support.respond : support.followUp
      if (!supported || !adapter.sendInput) return { id, outcome: "unsupported" as const }
      return adapter.sendInput(input, options)
    },
    support,
  } as AgentInvocationController<TOutput, CALL_OPTIONS, TResult>
  let cachedResult: Promise<TResult> | undefined
  Object.defineProperty(controller, "result", {
    enumerable: true,
    get() {
      cachedResult ||= hasRuntimeType(result, "function") ? result() : result
      void cachedResult.catch(() => {})
      return cachedResult
    },
  })
  Object.defineProperty(controller, agentInvocationStartResult, { value: startResult })
  return Object.freeze(controller)
}

export function awaitAgentInvocationResult(controller: AgentInvocationController): Promise<unknown> {
  // SAFETY: createAgentInvocationController attaches the private start result to every controller it returns.
  return (controller as InternalAgentInvocationController)[agentInvocationStartResult]
}

function randomAgentInvocationId(): string {
  return `ainv_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`
}

function isTerminalAgentInvocationStatus(status: AgentInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

export function startLiveAgentInvocation<TOutput = unknown, CALL_OPTIONS = unknown, TResult = unknown>(
  options: LiveAgentInvocationOptions<TOutput, CALL_OPTIONS, TResult>,
): AgentInvocationController<TOutput, CALL_OPTIONS, TResult> {
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
      if (outcome.status === "completed") {
        snapshot = { id, status: "completed" }
        if (outcome.output !== undefined) snapshot.output = outcome.output
      }
      else {
        snapshot = abortSignal.aborted
          ? { id, status: "cancelled" }
          : { error: outcome.error, id, status: "failed" }
      }
    },
  })
  void result.catch((error) => {
    if (observedFinish) return
    snapshot = abortSignal.aborted
      ? { id, status: "cancelled" }
      : { error, id, status: "failed" }
  })
  return createAgentInvocationController<TOutput, CALL_OPTIONS, TResult>(id, {
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
    async sendInput(input, inputOptions) {
      const outcome = options.sendInput
        ? await options.sendInput(id, input, inputOptions)
        : "unsupported"
      return { id, invocation: { ...snapshot }, outcome }
    },
    support: options.support ? () => options.support!(id) : undefined,
  }, result)
}

export function createBackedAgentInvocationController<TOutput = unknown, TResult = unknown>(
  options: BackedAgentInvocationOptions<TOutput, TResult>,
): AgentInvocationController<TOutput, unknown, TResult> {
  let removeParentAbortListener: (() => void) | undefined
  const stopObservingParent = () => {
    removeParentAbortListener?.()
    removeParentAbortListener = undefined
  }
  const observeTerminalSnapshot = (snapshot: AgentInvocationSnapshot<TOutput> | undefined) => {
    if (snapshot && isTerminalAgentInvocationStatus(snapshot.status)) {
      stopObservingParent()
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
  const controller = createAgentInvocationController<TOutput, unknown, TResult>(options.id, {
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
  }, options.result, options.startResult)
  if (options.parentAbortSignal) {
    const parentAbortSignal = options.parentAbortSignal
    const cancel = () => void controller.cancel(parentAbortSignal.reason)
    if (options.parentAbortSignal.aborted) cancel()
    else {
      parentAbortSignal.addEventListener("abort", cancel, { once: true })
      removeParentAbortListener = () => parentAbortSignal.removeEventListener("abort", cancel)
    }
  }
  void options.settled?.then(stopObservingParent, stopObservingParent)
  return controller
}
