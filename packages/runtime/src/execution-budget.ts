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
  /** Release timers and abort listeners owned by this budget and its children. */
  dispose(): void
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
  readonly node: BudgetNode
}

interface BudgetNode {
  readonly cleanups: Set<() => void>
  readonly children: Set<BudgetNode>
  readonly parent?: BudgetNode
  disposed: boolean
}

function createBudgetNode(parent?: BudgetNode): BudgetNode {
  const node: BudgetNode = {
    cleanups: new Set(),
    children: new Set(),
    ...(parent ? { parent } : {}),
    disposed: false,
  }
  parent?.children.add(node)
  return node
}

function registerBudgetCleanup(node: BudgetNode, cleanup: () => void): void {
  if (node.disposed) {
    cleanup()
    return
  }
  node.cleanups.add(cleanup)
}

function disposeBudgetNode(node: BudgetNode): void {
  if (node.disposed) return
  node.disposed = true
  for (const child of [...node.children]) disposeBudgetNode(child)
  node.children.clear()
  for (const cleanup of [...node.cleanups]) cleanup()
  node.cleanups.clear()
  node.parent?.children.delete(node)
}

export function createExecutionBudget(options: ExecutionBudgetOptions = {}): ExecutionBudget {
  const limits = normalizeLimits(options)
  const controller = new AbortController()
  const state: BudgetState = {
    controller,
    limits,
    usage: { inputBytes: 0, outputBytes: 0, retries: 0, toolCalls: 0 },
    node: createBudgetNode(),
  }
  const abortFromExternal = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) abortFromExternal()
    else {
      options.signal.addEventListener("abort", abortFromExternal, { once: true })
      registerBudgetCleanup(state.node, () => options.signal?.removeEventListener("abort", abortFromExternal))
    }
  }
  if (limits.deadlineAt !== undefined) {
    const remaining = limits.deadlineAt - Date.now()
    if (remaining <= 0) controller.abort(new DOMException("Execution budget deadline exceeded.", "TimeoutError"))
    else {
      const timer = setTimeout(() => controller.abort(new DOMException("Execution budget deadline exceeded.", "TimeoutError")), remaining)
      registerBudgetCleanup(state.node, () => clearTimeout(timer))
    }
  }
  return createBudget(state, limits, controller, state.node)
}

function createBudget(state: BudgetState, limits: ExecutionBudgetLimits, controller: AbortController, node: BudgetNode): ExecutionBudget {
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
    dispose() {
      disposeBudgetNode(node)
    },
    child(options = {}) {
      const childLimits = normalizeLimits(options)
      const childController = new AbortController()
      const childNode = createBudgetNode(node)
      const abortChild = (reason?: unknown) => childController.abort(reason)
      if (state.controller.signal.aborted) abortChild(state.controller.signal.reason)
      else {
        const abortFromParent = () => abortChild(state.controller.signal.reason)
        state.controller.signal.addEventListener("abort", abortFromParent, { once: true })
        registerBudgetCleanup(childNode, () => state.controller.signal.removeEventListener("abort", abortFromParent))
      }
      if (options.signal) {
        if (options.signal.aborted) abortChild(options.signal.reason)
        else {
          const abortFromExternal = () => abortChild(options.signal?.reason)
          options.signal.addEventListener("abort", abortFromExternal, { once: true })
          registerBudgetCleanup(childNode, () => options.signal?.removeEventListener("abort", abortFromExternal))
        }
      }
      const deadlineAt = minDefined(limits.deadlineAt, childLimits.deadlineAt)
      if (deadlineAt !== undefined) {
        const remaining = deadlineAt - Date.now()
        if (remaining <= 0) abortChild(new DOMException("Execution budget deadline exceeded.", "TimeoutError"))
        else {
          const timer = setTimeout(() => abortChild(new DOMException("Execution budget deadline exceeded.", "TimeoutError")), remaining)
          registerBudgetCleanup(childNode, () => clearTimeout(timer))
        }
      }
      return createBudget(state, {
        deadlineAt,
        maxInputBytes: minDefined(limits.maxInputBytes, childLimits.maxInputBytes),
        maxOutputBytes: minDefined(limits.maxOutputBytes, childLimits.maxOutputBytes),
        maxRetries: minDefined(limits.maxRetries, childLimits.maxRetries),
        maxToolCalls: minDefined(limits.maxToolCalls, childLimits.maxToolCalls),
      }, childController, childNode)
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
        cancelled: state.controller.signal.aborted || controller.signal.aborted,
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
