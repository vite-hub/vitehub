import type { WorkflowDefinition, WorkflowDurationUnit, WorkflowExecutionContext, WorkflowProviderContext, WorkflowStepFunction, WorkflowStepOptions } from "../types.ts"
import { isResponse, serializeResponse, toResponse } from "@vite-hub/runtime"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { getWorkflowDevRecorder } from "./dev-recorder.ts"

const defaultStepOptions = {
  retries: {
    backoff: "exponential",
    delay: "10 seconds",
    limit: 3,
  },
} satisfies WorkflowStepOptions

export async function runProviderStep<TResult>(
  step: WorkflowProviderContext["step"],
  name: string,
  run: () => TResult | Promise<TResult>,
  options: WorkflowStepOptions = defaultStepOptions,
): Promise<TResult> {
  if (typeof step?.do === "function") {
    return await step.do(name, options, run)
  }

  const recorder = getWorkflowDevRecorder()
  return recorder ? await recorder.step(name, run) : await run()
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
  stepModules: Array<{ name: string, run: WorkflowStepFunction }>,
): Record<string, WorkflowStepFunction> {
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
        () => module.run(input),
      ),
    ]
  }))
}

/** The units of a sleep duration, in milliseconds. Cloudflare reads a month as 30 days and a year as 365.25 days. */
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

/** A sleep target: a number of milliseconds, or a date. */
function toSleepTarget(name: string, until: unknown): number | Date {
  if (Object.prototype.toString.call(until) === "[object Date]") {
    // SAFETY: The tag check above accepts a Date from any realm.
    const date = new Date((until as Date).getTime())
    if (Number.isFinite(date.getTime())) return date
  }
  else if (typeof until === "number") {
    if (Number.isFinite(until) && until >= 0) return until
  }
  else if (typeof until === "string") {
    const match = durationPattern.exec(until)
    // SAFETY: The pattern only matches the unit names of `durationUnits`.
    if (match) return Number(match[1]) * durationUnits[match[2] as WorkflowDurationUnit]
  }
  const value = typeof until === "string" ? JSON.stringify(until) : String(until)
  throw workflowErrorDiagnostics.WORKFLOW_SLEEP_DURATION_INVALID({ name, value })
}

/** Node fires a timer longer than this at once, so a longer wait uses more than one timer. */
const maxTimerDelay = 2_147_483_647

async function waitUntil(time: number): Promise<void> {
  for (let left = time - Date.now(); left > 0; left = time - Date.now()) {
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(left, maxTimerDelay)))
  }
}

/**
 * `context.sleep()` of a folder Workflow. It names each sleep by call order (`sleep-1`, `sleep-2`), so the orchestrator
 * must call it in the same order on each replay. Without a provider sleep, the run is inline and waits with a timer.
 */
function createSleep(context: WorkflowProviderContext): WorkflowExecutionContext["sleep"] {
  let count = 0
  return async (until) => {
    const target = toSleepTarget(context.name, until)
    const name = `sleep-${++count}`
    const step = context.step
    if (step?.sleep) {
      if (typeof target === "number") return await step.sleep(name, target)
      if (step.sleepUntil) return await step.sleepUntil(name, target)
      // A provider stores the wake time of a sleep and does not read the duration again on replay.
      return await step.sleep(name, Math.max(0, target.getTime() - Date.now()))
    }
    const time = typeof target === "number" ? Date.now() + target : target.getTime()
    await runProviderStep(undefined, name, async () => await waitUntil(time))
  }
}

/**
 * Gives every handler `context.sleep()` and a step runner. Generated folder Workflows replace this empty runner with
 * their step files. The context keeps the provider step at runtime, so the generated step runner can use it.
 */
function toExecutionContext<TPayload>(context: WorkflowProviderContext<TPayload>, sleep: WorkflowExecutionContext["sleep"]): WorkflowExecutionContext<TPayload> {
  return { ...context, sleep, steps: {} }
}

/** The root step result that says the handler called `context.sleep()`. A replay reads it and fails the same way. */
const rootStepSleepResult = { "~vitehubRootStepSleep": true } as const

/**
 * Runs the handler in its root step, or alone for a folder Workflow (`rootStep: false`). A sleep inside the root step
 * fails the run with `WORKFLOW_ROOT_STEP_SLEEP` on every provider. The root step returns a marker instead of throwing,
 * so the provider does not retry it and run the code before the sleep again.
 */
async function runInRootStep<TPayload, TResult, TOutput>(
  context: WorkflowProviderContext<TPayload>,
  definition: WorkflowDefinition<TPayload, TResult>,
  encode: (value: TResult) => TOutput | Promise<TOutput>,
): Promise<TOutput> {
  if (definition.options?.rootStep === false) {
    return await encode(await definition.handler(context.payload, toExecutionContext(context, createSleep(context))))
  }

  let slept = false
  const sleepError = () => workflowErrorDiagnostics.WORKFLOW_ROOT_STEP_SLEEP({ name: context.name })
  const sleep = async () => {
    slept = true
    throw sleepError()
  }
  const output = await runProviderStep(context.step, context.name, async () => {
    try {
      const value = await encode(await definition.handler(context.payload, toExecutionContext(context, sleep)))
      return slept ? rootStepSleepResult : value
    }
    catch (error) {
      if (slept) return rootStepSleepResult
      throw error
    }
  })
  if (typeof output === "object" && output !== null && "~vitehubRootStepSleep" in output) throw sleepError()
  // SAFETY: Only a root step that slept returns the marker, and the check above throws for it.
  return output as TOutput
}

export async function runWorkflowHandler<TPayload, TResult>(
  context: WorkflowProviderContext<TPayload>,
  definition: WorkflowDefinition<TPayload, TResult>,
): Promise<Response> {
  return toResponse(await runInRootStep(context, definition, value => value))
}

/**
 * The stored result of a run. A `Response` from the handler is stored as a serialized Response. Any other value is
 * stored as JSON, so every provider returns the same plain value.
 */
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
