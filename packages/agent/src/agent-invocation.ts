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
  result?: (context: {
    finished: Promise<AgentInvocationFinishOutcome<TOutput>>
    startResult: Promise<TResult>
  }) => Promise<TResult>
  support?: (id: string) => Partial<AgentInvocationInputSupport>
}

export interface BackedAgentInvocationOptions<TOutput = unknown, TResult extends TOutput = TOutput> {
  cancel: () => Promise<AgentInvocationSnapshot<TOutput> | undefined>
  errorOutcome: (error: unknown) => "unsupported" | "unavailable"
  id: string
  inspect: () => Promise<AgentInvocationSnapshot<TOutput> | undefined>
  parentAbortSignal?: AbortSignal
  result: () => Promise<TResult>
  resultErrorStatus?: (error: unknown) => "failed" | undefined
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
  startResult?: Promise<unknown>,
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
  // SAFETY: the result getter added below completes the declared controller contract.
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
  const privateStartResult = startResult ?? (hasRuntimeType(result, "function") ? Promise.resolve() : result)
  Object.defineProperty(controller, agentInvocationStartResult, { value: privateStartResult })
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
  let resolveFinished!: (outcome: AgentInvocationFinishOutcome<TOutput>) => void
  const finished = new Promise<AgentInvocationFinishOutcome<TOutput>>((resolve) => {
    resolveFinished = resolve
  })
  const startResult = options.start({
    abortSignal,
    id,
    onFinish(outcome) {
      observedFinish = true
      resolveFinished(outcome)
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
  void startResult.catch((error) => {
    if (observedFinish) return
    const outcome: AgentInvocationFinishOutcome<TOutput> = { error, status: "failed" }
    resolveFinished(outcome)
    snapshot = abortSignal.aborted ? { id, status: "cancelled" } : { error, id, status: "failed" }
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
  }, options.result ? () => options.result!({ finished, startResult }) : startResult, startResult)
}

export function createBackedAgentInvocationController<TOutput = unknown, TResult extends TOutput = TOutput>(
  options: BackedAgentInvocationOptions<TOutput, TResult>,
): AgentInvocationController<TOutput, unknown, TResult> {
  let removeParentAbortListener: (() => void) | undefined
  let terminalSnapshot: AgentInvocationSnapshot<TOutput> | undefined
  const stopObservingParent = () => {
    removeParentAbortListener?.()
    removeParentAbortListener = undefined
  }
  const readTerminalSnapshot = (): AgentInvocationSnapshot<TOutput> | undefined => terminalSnapshot
  const observeTerminalSnapshot = (snapshot: AgentInvocationSnapshot<TOutput> | undefined) => {
    if (snapshot && isTerminalAgentInvocationStatus(snapshot.status)) {
      terminalSnapshot ??= snapshot
      stopObservingParent()
      return terminalSnapshot
    }
    return snapshot
  }
  const inspect = async (): Promise<AgentInvocationInspection<TOutput>> => {
    const cachedTerminalSnapshot = terminalSnapshot
    if (cachedTerminalSnapshot) return { invocation: { ...cachedTerminalSnapshot }, outcome: "available" }
    try {
      const snapshot = observeTerminalSnapshot(await options.inspect())
      const settledTerminalSnapshot = terminalSnapshot
      if (settledTerminalSnapshot) return { invocation: { ...settledTerminalSnapshot }, outcome: "available" }
      return snapshot
        ? { invocation: snapshot, outcome: "available" }
        : { id: options.id, outcome: "unavailable" }
    }
    catch {
      const settledTerminalSnapshot = terminalSnapshot
      if (settledTerminalSnapshot) return { invocation: { ...settledTerminalSnapshot }, outcome: "available" }
      return { id: options.id, outcome: "unavailable" }
    }
  }
  const controller = createAgentInvocationController<TOutput, unknown, TResult>(options.id, {
    async cancel() {
      if (terminalSnapshot) {
        return { id: options.id, invocation: { ...terminalSnapshot }, outcome: "invalid-state" }
      }
      try {
        const providerSnapshot = await options.cancel()
        const settledTerminalSnapshot = readTerminalSnapshot()
        if (settledTerminalSnapshot) {
          return { id: options.id, invocation: { ...settledTerminalSnapshot }, outcome: "invalid-state" }
        }
        const snapshot = observeTerminalSnapshot(providerSnapshot)
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
        const settledTerminalSnapshot = readTerminalSnapshot()
        if (settledTerminalSnapshot) {
          return { id: options.id, invocation: { ...settledTerminalSnapshot }, outcome: "invalid-state" }
        }
        return { id: options.id, outcome: options.errorOutcome(error) }
      }
    },
    inspect,
    async sendInput() {
      return { id: options.id, outcome: "unsupported" }
    },
  }, async () => {
    try {
      const output = await options.result()
      const snapshot: AgentInvocationSnapshot<TOutput> = { id: options.id, status: "completed" }
      if (output !== undefined) snapshot.output = output
      const authoritativeSnapshot = observeTerminalSnapshot(snapshot)
      if (authoritativeSnapshot?.status === "cancelled") {
        throw new DOMException("The invocation was cancelled.", "AbortError")
      }
      if (authoritativeSnapshot?.status === "failed") throw authoritativeSnapshot.error
      return output
    }
    catch (error) {
      const authoritativeSnapshot = readTerminalSnapshot()
      if (authoritativeSnapshot?.status === "cancelled") {
        throw new DOMException("The invocation was cancelled.", "AbortError")
      }
      if (authoritativeSnapshot?.status === "failed") throw authoritativeSnapshot.error
      if (authoritativeSnapshot?.status === "completed") {
        // SAFETY: a completed terminal snapshot stores the controller's declared result type.
        return authoritativeSnapshot.output as TResult
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        observeTerminalSnapshot({ id: options.id, status: "cancelled" })
      }
      else if (options.resultErrorStatus?.(error) === "failed") {
        observeTerminalSnapshot({ error, id: options.id, status: "failed" })
      }
      throw error
    }
  }, options.startResult)
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
