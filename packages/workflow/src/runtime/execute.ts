import type { WorkflowDefinition, WorkflowDuration, WorkflowDurationUnit, WorkflowExecutionContext, WorkflowProviderContext, WorkflowSignal, WorkflowStepContext, WorkflowStepFunction, WorkflowStepOptions, WorkflowStepRetries } from "../types.ts"
import { isResponse, serializeResponse, toResponse } from "@vite-hub/runtime/internal/response"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { createWorkflowError, isNonRetryableError, NonRetryableError } from "../errors.ts"
import { getWorkflowDevRecorder } from "./dev-recorder.ts"
import { closeInlineWorkflowSignals, createWorkflowSignalToken, openInlineWorkflowSignal, waitForInlineWorkflowSignal } from "./signals.ts"

/** The options of a step with the default retries filled in. */
export interface ResolvedWorkflowStepOptions {
  retries: Required<WorkflowStepRetries>
  timeout?: WorkflowDuration
}

const defaultRetries = {
  backoff: "exponential",
  delay: "10 seconds",
  limit: 3,
} satisfies Required<WorkflowStepRetries>

const stepOptionKeys = new Set(["retries", "timeout"])
const retryOptionKeys = new Set(["backoff", "delay", "limit"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Checks the options of a step and fills in the default retries. A step file, `context.step.do()`, and every provider
 * read the options through this function, so an invalid value fails the same way everywhere.
 */
export function resolveWorkflowStepOptions(step: string, options: unknown): ResolvedWorkflowStepOptions {
  const invalid = (option: string, value: unknown) => workflowErrorDiagnostics.WORKFLOW_STEP_OPTIONS_INVALID({
    option,
    step,
    value: typeof value === "string" ? JSON.stringify(value) : String(value),
  })
  if (options === undefined) return { retries: { ...defaultRetries } }
  if (!isPlainObject(options)) throw invalid("options", options)
  for (const key of Object.keys(options)) if (!stepOptionKeys.has(key)) throw invalid(key, options[key])

  const retries = options.retries ?? {}
  if (!isPlainObject(retries)) throw invalid("retries", retries)
  for (const key of Object.keys(retries)) if (!retryOptionKeys.has(key)) throw invalid(`retries.${key}`, retries[key])
  const { backoff = defaultRetries.backoff, delay = defaultRetries.delay, limit = defaultRetries.limit } = retries
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) throw invalid("retries.limit", limit)
  if (toDurationMilliseconds(delay) === undefined) throw invalid("retries.delay", delay)
  if (backoff !== "constant" && backoff !== "exponential") throw invalid("retries.backoff", backoff)

  const timeout = options.timeout
  if (timeout !== undefined && !toDurationMilliseconds(timeout)) throw invalid("timeout", timeout)
  // SAFETY: `toDurationMilliseconds` accepts only a number or a duration string, so `delay` and `timeout` are durations.
  return { retries: { backoff, delay: delay as WorkflowDuration, limit }, ...(timeout === undefined ? {} : { timeout: timeout as WorkflowDuration }) }
}

function onTimeout(milliseconds: number, callback: () => void): () => void {
  const deadline = Date.now() + milliseconds
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    timer = setTimeout(() => Date.now() >= deadline ? callback() : arm(), Math.min(Math.max(deadline - Date.now(), 0), maxTimerDelay))
  }
  arm()
  return () => clearTimeout(timer)
}

/**
 * Runs one attempt of a step. When `timeout` passes, the step's `signal` aborts and the attempt fails with
 * `WORKFLOW_STEP_TIMEOUT`, so the provider retries it. A step that ignores the signal keeps running in the background:
 * JavaScript cannot stop a promise.
 */
export async function runWorkflowStepAttempt<TResult>(
  step: string,
  timeout: WorkflowDuration | undefined,
  run: (context: WorkflowStepContext) => TResult | Promise<TResult>,
): Promise<TResult> {
  const controller = new AbortController()
  const milliseconds = timeout === undefined ? undefined : toDurationMilliseconds(timeout)
  if (milliseconds === undefined) return await run({ signal: controller.signal })

  const label = typeof timeout === "number" ? `${timeout} ms` : String(timeout)
  let cancel = () => {}
  const expired = new Promise<never>((_resolve, reject) => {
    cancel = onTimeout(milliseconds, () => {
      const error = workflowErrorDiagnostics.WORKFLOW_STEP_TIMEOUT({ step, timeout: label })
      controller.abort(error)
      reject(error)
    })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => run({ signal: controller.signal })), expired])
  }
  finally {
    cancel()
  }
}

const timedAttempts = new WeakSet<() => unknown>()

/** Adds a timeout once, including when a provider receives an already wrapped folder step. */
export function withWorkflowStepTimeout<TResult>(
  name: string,
  timeout: WorkflowDuration | undefined,
  run: () => TResult | Promise<TResult>,
): () => TResult | Promise<TResult> {
  if (timeout === undefined || timedAttempts.has(run)) return run
  const attempt = () => runWorkflowStepAttempt(name, timeout, run)
  timedAttempts.add(attempt)
  return attempt
}

export async function runProviderStep<TResult>(
  step: WorkflowProviderContext["step"],
  name: string,
  run: (context: WorkflowStepContext) => TResult | Promise<TResult>,
  options?: WorkflowStepOptions,
): Promise<TResult> {
  const resolved = resolveWorkflowStepOptions(name, options)
  const attempt = () => runWorkflowStepAttempt(name, resolved.timeout, run)
  timedAttempts.add(attempt)
  if (typeof step?.do === "function") {
    return await step.do(name, resolved, attempt)
  }

  const recorder = getWorkflowDevRecorder()
  return recorder ? await recorder.step(name, attempt) : await attempt()
}

/** `01.create-user.ts` becomes the `createUser` step. */
export function toStepPropertyName(file: string): string {
  const base = file
    .split("/")
    .pop()!
    .replace(/\.(?:c|m)?[jt]s$/i, "")
    .replace(/^\d+[.-]?/, "")

  return base.replace(/[-_.]+([a-z0-9])/gi, (_, char: string) => char.toUpperCase())
}

export function createWorkflowSteps(
  context: WorkflowProviderContext,
  stepModules: Array<{ name: string, options?: WorkflowStepOptions, run: WorkflowStepFunction }>,
): Record<string, (input: unknown) => Promise<unknown>> {
  const names = new Map<string, string>()
  return Object.fromEntries(stepModules.map((module) => {
    const propertyName = toStepPropertyName(module.name)
    if (!propertyName) {
      throw workflowErrorDiagnostics.WORKFLOW_C0011({
        message: `[vitehub] Workflow step file ${JSON.stringify(module.name)} normalizes to an empty step property. Rename the file so the step property is non-empty.`,
      })
    }
    const previousName = names.get(propertyName)
    if (previousName) {
      throw workflowErrorDiagnostics.WORKFLOW_C0010({
        message: `[vitehub] Workflow step files ${JSON.stringify(previousName)} and ${JSON.stringify(module.name)} both normalize to the \`${propertyName}\` step property. Rename one file so each step property is unique.`,
      })
    }
    names.set(propertyName, module.name)
    return [
      propertyName,
      async (input: unknown) => await runProviderStep(
        context.step,
        `${context.name}/${module.name}`,
        stepContext => module.run(input, stepContext),
        module.options,
      ),
    ]
  }))
}

const durationUnits = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_557_600_000,
} satisfies Record<WorkflowDurationUnit, number>

const durationPattern = /^(\d+(?:\.\d+)?) (second|minute|hour|day|week|month|year)s?$/

/** The milliseconds of a `WorkflowDuration`: a number of 0 or more, or a string such as `'30 seconds'`. */
export function toDurationMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value !== "string") return undefined
  const match = durationPattern.exec(value)
  // SAFETY: The pattern only matches the unit names of `durationUnits`.
  return match ? Number(match[1]) * durationUnits[match[2] as WorkflowDurationUnit] : undefined
}

function toSleepTarget(name: string, until: unknown): number | Date {
  if (Object.prototype.toString.call(until) === "[object Date]") {
    // SAFETY: The tag check above accepts a Date from any realm.
    const date = new Date((until as Date).getTime())
    if (Number.isFinite(date.getTime())) return date
  }
  else {
    const milliseconds = toDurationMilliseconds(until)
    if (milliseconds !== undefined) return milliseconds
  }
  const value = typeof until === "string" ? JSON.stringify(until) : String(until)
  throw workflowErrorDiagnostics.WORKFLOW_SLEEP_DURATION_INVALID({ name, value })
}

const maxTimerDelay = 2_147_483_647

async function waitUntil(time: number): Promise<void> {
  for (let left = time - Date.now(); left > 0; left = time - Date.now()) {
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(left, maxTimerDelay)))
  }
}

function createSleep(context: WorkflowProviderContext): WorkflowExecutionContext["sleep"] {
  let count = 0
  return async (until) => {
    const target = toSleepTarget(context.name, until)
    const name = `sleep-${++count}`
    const step = context.step
    if (step?.sleep) {
      if (typeof target === "number") return await step.sleep(name, target)
      if (step.sleepUntil) return await step.sleepUntil(name, target)
      return await step.sleep(name, Math.max(0, target.getTime() - Date.now()))
    }
    const time = typeof target === "number" ? Date.now() + target : target.getTime()
    await runProviderStep(undefined, name, async () => await waitUntil(time))
  }
}

interface WorkflowSignals {
  createSignal: WorkflowExecutionContext["createSignal"]
  close: () => void
}

function createSignals(context: WorkflowProviderContext, wait?: () => Promise<never>): WorkflowSignals {
  let count = 0
  const inlineTokens: string[] = []
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The value comes from a resumeWorkflow() call in another request, so no input at this call site can type it.
  const createSignal = <TValue>(): WorkflowSignal<TValue> => {
    if (context.provider === "vercel") throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_VERCEL_UNSUPPORTED({ name: context.name })
    const step = context.step
    if (step?.do && !step.waitForSignal) throw createWorkflowError({ code: "WORKFLOW_OPERATION_UNSUPPORTED", details: { operation: "signals", provider: context.provider } })
    const name = `signal-${++count}`
    const inline = !step?.waitForSignal
    const token = createWorkflowSignalToken({ host: inline ? "inline" : context.provider, run: context.id ?? "", signal: name, workflow: context.name })
    if (inline) {
      openInlineWorkflowSignal(token)
      inlineTokens.push(token)
    }
    let waiting: Promise<TValue> | undefined
    return {
      token,
      // SAFETY: `TValue` is the type that the caller of `resumeWorkflow()` sends for this token.
      wait: () => waiting ??= (wait ? wait() : inline
        ? runProviderStep(undefined, name, async () => await waitForInlineWorkflowSignal(token))
        : step!.waitForSignal!(name, token)) as Promise<TValue>,
    }
  }
  return { close: () => closeInlineWorkflowSignals(inlineTokens), createSignal }
}

function toExecutionContext<TPayload>(context: WorkflowProviderContext<TPayload>, sleep: WorkflowExecutionContext["sleep"], createSignal: WorkflowExecutionContext["createSignal"]): WorkflowExecutionContext<TPayload> {
  // SAFETY: `WorkflowSteps` types the steps of every folder Workflow. A Workflow without step files has none, and the
  // generated entry of a folder Workflow replaces this object with its own steps.
  return { ...context, createSignal, sleep, steps: {} as WorkflowExecutionContext["steps"] }
}

const rootStepSleepResult = { "~vitehubRootStepSleep": true } as const
const rootStepSignalResult = { "~vitehubRootStepSignal": true } as const

/**
 * The step result that says the step threw a `NonRetryableError`. A provider that retries every error, such as
 * OpenWorkflow, ends the step with it, so it does not run the step again. The caller throws the error outside the
 * step, and a replay reads the stored result and throws the same error.
 */
export interface NonRetryableStepResult {
  "~vitehubNonRetryableError": { code?: string, message: string, name: string }
}

export function toNonRetryableStepResult(error: unknown): NonRetryableStepResult | undefined {
  if (!isNonRetryableError(error)) return undefined
  const code: unknown = Reflect.get(error, "code")
  return { "~vitehubNonRetryableError": { ...(typeof code === "string" ? { code } : {}), message: error.message, name: error.name } }
}

export function readNonRetryableStepResult(value: unknown): NonRetryableError | undefined {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "~vitehubNonRetryableError")) return undefined
  // SAFETY: Only toNonRetryableStepResult writes this key.
  const { code, message, name } = (value as NonRetryableStepResult)["~vitehubNonRetryableError"]
  const error = new NonRetryableError(message)
  error.name = name
  return code === undefined ? error : Object.assign(error, { code })
}

async function runInRootStep<TPayload, TResult, TOutput>(
  context: WorkflowProviderContext<TPayload>,
  definition: WorkflowDefinition<TPayload, TResult>,
  encode: (value: TResult) => TOutput | Promise<TOutput>,
): Promise<TOutput> {
  if (definition.rootStep === false) {
    const signals = createSignals(context)
    try {
      return await encode(await definition.handler(toExecutionContext(context, createSleep(context), signals.createSignal)))
    }
    finally {
      signals.close()
    }
  }

  let suspended: typeof rootStepSignalResult | typeof rootStepSleepResult | undefined
  const sleepError = () => workflowErrorDiagnostics.WORKFLOW_ROOT_STEP_SLEEP({ name: context.name })
  const signalError = () => workflowErrorDiagnostics.WORKFLOW_ROOT_STEP_SIGNAL({ name: context.name })
  const sleep = async () => {
    suspended = rootStepSleepResult
    throw sleepError()
  }
  const signals = createSignals(context, async () => {
    suspended = rootStepSignalResult
    throw signalError()
  })
  const output = await runProviderStep(context.step, context.name, async () => {
    try {
      const value = await encode(await definition.handler(toExecutionContext(context, sleep, signals.createSignal)))
      return suspended ?? value
    }
    catch (error) {
      if (suspended) return suspended
      throw error
    }
    finally {
      signals.close()
    }
  })
  if (typeof output === "object" && output !== null && "~vitehubRootStepSleep" in output) throw sleepError()
  if (typeof output === "object" && output !== null && "~vitehubRootStepSignal" in output) throw signalError()
  // SAFETY: Only a root step that waited returns a marker, and the checks above throw for it.
  return output as TOutput
}

export async function runWorkflowHandler<TPayload, TResult>(
  context: WorkflowProviderContext<TPayload>,
  definition: WorkflowDefinition<TPayload, TResult>,
): Promise<Response> {
  return toResponse(await runInRootStep(context, definition, value => value))
}

async function toStoredWorkflowResult(value: unknown): Promise<unknown> {
  if (isResponse(value)) return await serializeResponse(value)
  const json = JSON.stringify(value)
  return json === undefined ? undefined : JSON.parse(json)
}

/** Encode inside the root step so both checkpoints and final outputs survive replay. */
export async function runSerializedWorkflowHandler<TPayload, TResult>(
  context: WorkflowProviderContext<TPayload>,
  definition: WorkflowDefinition<TPayload, TResult>,
): Promise<unknown> {
  return await runInRootStep(context, definition, toStoredWorkflowResult)
}
