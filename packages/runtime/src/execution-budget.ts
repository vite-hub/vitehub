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
  cancel(reason?: unknown): void
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
  readonly limits: ExecutionBudgetLimits
  readonly usage: ExecutionBudgetUsage
}

export function createExecutionBudget(options: ExecutionBudgetOptions = {}): ExecutionBudget {
  const limits = normalizeLimits(options)
  const controller = new AbortController()
  const state: BudgetState = {
    controller,
    limits,
    usage: { inputBytes: 0, outputBytes: 0, retries: 0, toolCalls: 0 },
  }
  const abortFromExternal = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) abortFromExternal()
    else {
      options.signal.addEventListener("abort", abortFromExternal, { once: true })
      controller.signal.addEventListener("abort", () => options.signal?.removeEventListener("abort", abortFromExternal), { once: true })
    }
  }
  if (limits.deadlineAt !== undefined) scheduleDeadline(controller, limits.deadlineAt)
  return createBudget(state, limits, controller)
}

function scheduleDeadline(controller: AbortController, deadlineAt: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (controller.signal.aborted) return
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) controller.abort(new DOMException("Execution budget timed out: deadline exceeded.", "TimeoutError"))
    else {
      timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647))
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Timer handles are numbers in browsers and objects with unref in Node.
      if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref()
    }
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
  schedule()
}

function createBudget(state: BudgetState, limits: ExecutionBudgetLimits, controller: AbortController): ExecutionBudget {
  function assertAvailable(counter: ExecutionBudgetCounter, amount: number) {
    state.controller.signal.throwIfAborted()
    controller.signal.throwIfAborted()
    if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`[vitehub] Execution budget ${counter} amount must be a finite non-negative number.`)
    const next = state.usage[counter] + amount
    const limit = limitFor(counter, limits)
    if (limit !== undefined && next > limit) throw new ExecutionBudgetExceededError(counter, limit)
  }

  function consume(counter: ExecutionBudgetCounter, amount = 1) {
    assertAvailable(counter, amount)
    state.usage[counter] += amount
  }

  return {
    signal: controller.signal,
    cancel(reason) {
      controller.abort(reason)
    },
    child(options = {}) {
      const childLimits = normalizeLimits(options)
      const childController = new AbortController()
      const abortChild = (reason?: unknown) => childController.abort(reason)
      if (state.controller.signal.aborted) abortChild(state.controller.signal.reason)
      else {
        const abortFromParent = () => abortChild(state.controller.signal.reason)
        state.controller.signal.addEventListener("abort", abortFromParent, { once: true })
        childController.signal.addEventListener("abort", () => state.controller.signal.removeEventListener("abort", abortFromParent), { once: true })
      }
      if (options.signal) {
        if (options.signal.aborted) abortChild(options.signal.reason)
        else {
          const abortFromExternal = () => abortChild(options.signal?.reason)
          options.signal.addEventListener("abort", abortFromExternal, { once: true })
          childController.signal.addEventListener("abort", () => options.signal?.removeEventListener("abort", abortFromExternal), { once: true })
        }
      }
      const deadlineAt = minDefined(limits.deadlineAt, childLimits.deadlineAt)
      if (deadlineAt !== undefined) scheduleDeadline(childController, deadlineAt)
      return createBudget(state, {
        deadlineAt,
        maxInputBytes: minDefined(limits.maxInputBytes, childLimits.maxInputBytes),
        maxOutputBytes: minDefined(limits.maxOutputBytes, childLimits.maxOutputBytes),
        maxRetries: minDefined(limits.maxRetries, childLimits.maxRetries),
        maxToolCalls: minDefined(limits.maxToolCalls, childLimits.maxToolCalls),
      }, childController)
    },
    consume(counter, amount = 1) {
      try {
        consume(counter, amount)
      }
      catch (error) {
        if (error instanceof ExecutionBudgetExceededError) controller.abort(error)
        throw error
      }
    },
    recordInputBytes(amount) {
      try {
        assertAvailable("inputBytes", amount)
        state.usage.inputBytes += amount
      }
      catch (error) {
        if (error instanceof ExecutionBudgetExceededError) controller.abort(error)
        throw error
      }
    },
    recordOutputBytes(amount) {
      try {
        assertAvailable("outputBytes", amount)
        state.usage.outputBytes += amount
      }
      catch (error) {
        if (error instanceof ExecutionBudgetExceededError) controller.abort(error)
        throw error
      }
    },
    recordRetry() {
      try {
        assertAvailable("retries", 1)
        state.usage.retries += 1
      }
      catch (error) {
        if (error instanceof ExecutionBudgetExceededError) controller.abort(error)
        throw error
      }
    },
    recordToolCall(inputBytes = 0) {
      try {
        assertAvailable("toolCalls", 1)
        if (inputBytes) assertAvailable("inputBytes", inputBytes)
        state.usage.toolCalls += 1
        if (inputBytes) state.usage.inputBytes += inputBytes
      }
      catch (error) {
        if (error instanceof ExecutionBudgetExceededError) controller.abort(error)
        throw error
      }
    },
    snapshot() {
      const remainingTime = limits.deadlineAt === undefined ? undefined : Math.max(0, limits.deadlineAt - Date.now())
      return {
        cancelled: state.controller.signal.aborted || controller.signal.aborted,
        // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Snapshot fields are omitted when the corresponding limit is unset.
        ...(limits.deadlineAt === undefined ? {} : { deadlineAt: limits.deadlineAt }),
        limits: { ...limits },
        remaining: {
          // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Snapshot fields are omitted when the corresponding limit is unset.
          ...(limits.maxInputBytes === undefined ? {} : { inputBytes: Math.max(0, limits.maxInputBytes - state.usage.inputBytes) }),
          // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Snapshot fields are omitted when the corresponding limit is unset.
          ...(limits.maxOutputBytes === undefined ? {} : { outputBytes: Math.max(0, limits.maxOutputBytes - state.usage.outputBytes) }),
          // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Snapshot fields are omitted when the corresponding limit is unset.
          ...(limits.maxRetries === undefined ? {} : { retries: Math.max(0, limits.maxRetries - state.usage.retries) }),
          // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Snapshot fields are omitted when the corresponding limit is unset.
          ...(limits.maxToolCalls === undefined ? {} : { toolCalls: Math.max(0, limits.maxToolCalls - state.usage.toolCalls) }),
          // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Snapshot fields are omitted when the deadline is unset.
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
