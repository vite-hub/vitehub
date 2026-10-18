/** Counters that an Invocation can spend while it runs. */
export type ExecutionBudgetCounter = "inputBytes" | "outputBytes" | "retries" | "toolCalls"

export interface ExecutionBudgetLimits {
  deadlineAt?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxRetries?: number
  maxToolCalls?: number
}

export interface ExecutionBudgetUsage {
  inputBytes: number
  outputBytes: number
  retries: number
  toolCalls: number
}

export interface ExecutionBudgetSnapshot {
  cancelled: boolean
  deadlineAt?: number
  limits: Readonly<ExecutionBudgetLimits>
  remaining: {
    inputBytes?: number
    outputBytes?: number
    retries?: number
    toolCalls?: number
    timeMs?: number
  }
  usage: Readonly<ExecutionBudgetUsage>
}

export interface ExecutionBudgetOptions extends ExecutionBudgetLimits {
  signal?: AbortSignal
}

export class ExecutionBudgetExceededError extends Error {
  readonly counter: ExecutionBudgetCounter | "deadline"
  readonly limit?: number

  constructor(counter: ExecutionBudgetCounter | "deadline", limit?: number) {
    super(`[vitehub] Execution budget exhausted${counter === "deadline" ? " at the deadline" : ` for ${counter}`}.`)
    this.name = "ExecutionBudgetExceededError"
    this.counter = counter
    this.limit = limit
  }
}

export interface ExecutionBudget {
  readonly signal: AbortSignal
  child(options?: ExecutionBudgetOptions): ExecutionBudget
  consume(counter: ExecutionBudgetCounter, amount?: number): void
  recordInputBytes(amount: number): void
  recordOutputBytes(amount: number): void
  recordRetry(): void
  recordToolCall(inputBytes?: number): void
  snapshot(): ExecutionBudgetSnapshot
}

interface BudgetState {
  readonly controller: AbortController
  readonly sharedController: AbortController
  readonly limits: ExecutionBudgetLimits
  readonly usage: ExecutionBudgetUsage
}

export function createExecutionBudget(options: ExecutionBudgetOptions = {}): ExecutionBudget {
  const limits = normalizeLimits(options)
  const controller = new AbortController()
  const state: BudgetState = {
    controller,
    sharedController: new AbortController(),
    limits,
    usage: { inputBytes: 0, outputBytes: 0, retries: 0, toolCalls: 0 },
  }
  const abortFromExternal = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) abortFromExternal()
    else {
      options.signal.addEventListener("abort", abortFromExternal, { once: true })
      const removeExternalListener = () => options.signal?.removeEventListener("abort", abortFromExternal)
      controller.signal.addEventListener("abort", removeExternalListener, { once: true })
      state.sharedController.signal.addEventListener("abort", removeExternalListener, { once: true })
    }
  }
  if (limits.deadlineAt !== undefined) scheduleDeadline(controller, limits.deadlineAt, state.sharedController.signal)
  return createBudget(state, limits, controller, options.signal)
}

function scheduleDeadline(controller: AbortController, deadlineAt: number, sharedSignal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (controller.signal.aborted) return
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) controller.abort(new DOMException("Execution budget deadline exceeded.", "TimeoutError"))
    else {
      timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647))
      if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref()
    }
  }
  const clear = () => clearTimeout(timer)
  controller.signal.addEventListener("abort", clear, { once: true })
  sharedSignal?.addEventListener("abort", clear, { once: true })
  schedule()
}

function createBudget(state: BudgetState, limits: ExecutionBudgetLimits, controller: AbortController, externalSignal?: AbortSignal): ExecutionBudget {
  function assertAvailable(counter: ExecutionBudgetCounter, amount: number) {
    const stateReason = state.controller.signal.reason
    const controllerReason = controller.signal.reason
    const sharedReason = state.sharedController.signal.reason
    if (state.controller.signal.aborted && !(stateReason instanceof ExecutionBudgetExceededError)) state.controller.signal.throwIfAborted()
    if (controller.signal.aborted && !(controllerReason instanceof ExecutionBudgetExceededError)) controller.signal.throwIfAborted()
    if (externalSignal?.aborted && !(externalSignal.reason instanceof ExecutionBudgetExceededError)) externalSignal.throwIfAborted()
    if (state.sharedController.signal.aborted) {
      if (sharedReason instanceof ExecutionBudgetExceededError) throw sharedReason
      state.sharedController.signal.throwIfAborted()
    }
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`[vitehub] Execution budget ${counter} amount must be a finite non-negative number.`)
    const next = state.usage[counter] + amount
    const limit = limitFor(counter, limits)
    if (limit !== undefined && next > limit) {
      const error = new ExecutionBudgetExceededError(counter, limit)
      state.sharedController.abort(error)
      throw error
    }
    if (stateReason instanceof ExecutionBudgetExceededError) throw stateReason
    if (controllerReason instanceof ExecutionBudgetExceededError) throw controllerReason
  }

  function consume(counter: ExecutionBudgetCounter, amount = 1) {
    assertAvailable(counter, amount)
    state.usage[counter] += amount
  }

  return {
    signal: AbortSignal.any([controller.signal, state.sharedController.signal]),
    child(options = {}) {
      const childLimits = normalizeLimits(options)
      const childController = new AbortController()
      const abortChild = (reason?: unknown) => childController.abort(reason)
      const abortParent = () => abortChild(state.controller.signal.reason)
      if (state.controller.signal.aborted) abortParent()
      else {
        state.controller.signal.addEventListener("abort", abortParent, { once: true })
        childController.signal.addEventListener("abort", () => state.controller.signal.removeEventListener("abort", abortParent), { once: true })
      }
      if (options.signal) {
        const abortExternal = () => abortChild(options.signal?.reason)
        if (options.signal.aborted) abortExternal()
        else {
          options.signal.addEventListener("abort", abortExternal, { once: true })
          const removeExternalListener = () => options.signal?.removeEventListener("abort", abortExternal)
          childController.signal.addEventListener("abort", removeExternalListener, { once: true })
          state.sharedController.signal.addEventListener("abort", removeExternalListener, { once: true })
        }
      }
      const deadlineAt = minDefined(limits.deadlineAt, childLimits.deadlineAt)
      if (deadlineAt !== undefined) scheduleDeadline(childController, deadlineAt, state.sharedController.signal)
      return createBudget(state, {
        deadlineAt,
        maxInputBytes: minDefined(limits.maxInputBytes, childLimits.maxInputBytes),
        maxOutputBytes: minDefined(limits.maxOutputBytes, childLimits.maxOutputBytes),
        maxRetries: minDefined(limits.maxRetries, childLimits.maxRetries),
        maxToolCalls: minDefined(limits.maxToolCalls, childLimits.maxToolCalls),
      }, childController, options.signal)
    },
    consume(counter, amount = 1) {
      consume(counter, amount)
    },
    recordInputBytes(amount) {
      assertAvailable("inputBytes", amount)
      state.usage.inputBytes += amount
    },
    recordOutputBytes(amount) {
      assertAvailable("outputBytes", amount)
      state.usage.outputBytes += amount
    },
    recordRetry() {
      assertAvailable("retries", 1)
      state.usage.retries += 1
    },
    recordToolCall(inputBytes = 0) {
      assertAvailable("toolCalls", 1)
      if (inputBytes) assertAvailable("inputBytes", inputBytes)
      state.usage.toolCalls += 1
      if (inputBytes) state.usage.inputBytes += inputBytes
    },
    snapshot() {
      const remainingTime = limits.deadlineAt === undefined ? undefined : Math.max(0, limits.deadlineAt - Date.now())
      return {
        cancelled: state.controller.signal.aborted || controller.signal.aborted || state.sharedController.signal.aborted,
        ...(limits.deadlineAt === undefined ? {} : { deadlineAt: limits.deadlineAt }),
        limits: { ...limits },
        remaining: {
          ...(limits.maxInputBytes === undefined ? {} : { inputBytes: Math.max(0, limits.maxInputBytes - state.usage.inputBytes) }),
          ...(limits.maxOutputBytes === undefined ? {} : { outputBytes: Math.max(0, limits.maxOutputBytes - state.usage.outputBytes) }),
          ...(limits.maxRetries === undefined ? {} : { retries: Math.max(0, limits.maxRetries - state.usage.retries) }),
          ...(limits.maxToolCalls === undefined ? {} : { toolCalls: Math.max(0, limits.maxToolCalls - state.usage.toolCalls) }),
          ...(remainingTime === undefined ? {} : { timeMs: remainingTime }),
        },
        usage: { ...state.usage },
      }
    },
  }
}

function limitFor(counter: ExecutionBudgetCounter, limits: ExecutionBudgetLimits) {
  if (counter === "inputBytes") return limits.maxInputBytes
  if (counter === "outputBytes") return limits.maxOutputBytes
  if (counter === "retries") return limits.maxRetries
  return limits.maxToolCalls
}

function minDefined(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function normalizeLimits(options: ExecutionBudgetOptions): ExecutionBudgetLimits {
  const normalize = (value: number | undefined) => {
    if (value === undefined) return undefined
    if (!Number.isFinite(value) || value < 0) throw new RangeError("[vitehub] Execution budget limits must be finite non-negative numbers.")
    return Math.floor(value)
  }
  return {
    deadlineAt: normalize(options.deadlineAt),
    maxInputBytes: normalize(options.maxInputBytes),
    maxOutputBytes: normalize(options.maxOutputBytes),
    maxRetries: normalize(options.maxRetries),
    maxToolCalls: normalize(options.maxToolCalls),
  }
}
