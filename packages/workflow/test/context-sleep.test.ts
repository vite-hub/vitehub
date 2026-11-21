import { setTimeout as delay } from "node:timers/promises"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkflowDefinition, WorkflowExecutionContext, WorkflowProviderStep } from "../src/types.ts"
import { defineWorkflow } from "../src/definition.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { getWorkflowDevRecorder, setWorkflowDevRecorder } from "../src/runtime/dev-recorder.ts"
import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { unwrap } from "./unwrap.ts"

const rootStepSleep = { code: "WORKFLOW_ROOT_STEP_SLEEP", message: expect.stringContaining("folder Workflow") }
const calls: string[] = []

/** A single-file Workflow: the handler runs in the root step. */
const napInRootStep = defineWorkflow<undefined>({ handler: async ({ payload: _payload, ...context }) => {
  calls.push("before")
  await context.sleep("1 second")
  calls.push("after")
  return "rested"
} })

/** A folder Workflow orchestrator: the generated registry entry sets `rootStep: false`. */
function folderWorkflow<TPayload>(handler: (context: WorkflowExecutionContext<TPayload>) => Promise<string>): WorkflowDefinition<TPayload, string> {
  return { rootStep: false, handler }
}

const napInFolder = folderWorkflow<undefined>(async (context) => {
  calls.push("before")
  await context.sleep("1 second")
  calls.push("after")
  return "rested"
})

const napTwiceInFolder = folderWorkflow<{ until: string }>(async (context) => {
  calls.push("before")
  await context.sleep(1_000)
  calls.push("middle")
  await context.sleep(new Date(context.payload.until))
  calls.push("after")
  return "rested"
})

beforeEach(() => {
  resetWorkflowRuntime()
  calls.length = 0
})

describe("context.sleep() arguments", () => {
  it("rejects a duration that no provider reads the same way", async () => {
    const sleep = vi.fn(async () => {})
    const run = (value: unknown) => runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1" },
      name: "nap",
      // SAFETY: The test passes invalid input on purpose, as untyped JavaScript would.
      registry: { nap: async () => ({ default: folderWorkflow(async (context) => { await context.sleep(value as never); return "rested" }) }) },
      step: { do: async (_name, _options, run) => await run(), sleep },
    })

    for (const value of ["5s", "1 fortnight", "-1 day", "", -1, Number.NaN, Number.POSITIVE_INFINITY, new Date(Number.NaN)]) {
      await expect(run(value), String(value)).rejects.toMatchObject({ code: "WORKFLOW_SLEEP_DURATION_INVALID" })
    }
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe("Cloudflare", () => {
  it("fails a root step that sleeps, and does not call the provider sleep", async () => {
    const sleep = vi.fn(async () => {})
    const step: WorkflowProviderStep = { do: vi.fn(async (_name, _options, run) => await run()), sleep }

    await expect(runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1" },
      name: "nap",
      registry: { nap: async () => ({ default: napInRootStep }) },
      step,
    })).rejects.toMatchObject(rootStepSleep)

    expect(sleep).not.toHaveBeenCalled()
    expect(calls).toEqual(["before"])
  })

  it("fails again on replay without running the handler", async () => {
    let recorded: unknown
    const record: WorkflowProviderStep = { do: async (_name, _options, run) => recorded = await run(), sleep: async () => {} }
    const run = (step: WorkflowProviderStep) => runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1" },
      name: "nap",
      registry: { nap: async () => ({ default: napInRootStep }) },
      step,
    })
    await expect(run(record)).rejects.toMatchObject(rootStepSleep)

    // Cloudflare replays a finished step from its stored result, as structured clone.
    const replay: WorkflowProviderStep = { do: async <T>() => structuredClone(recorded) as T, sleep: async () => {} }
    await expect(run(replay)).rejects.toMatchObject(rootStepSleep)
    expect(calls).toEqual(["before"])
  })

  it("names each sleep by call order, and uses sleepUntil for a date", async () => {
    const providerCalls: unknown[][] = []
    const until = "2030-01-01T00:00:00.000Z"

    await expect(runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1", payload: { until } },
      name: "nap",
      registry: { nap: async () => ({ default: napTwiceInFolder }) },
      step: {
        do: async (_name, _options, run) => await run(),
        sleep: async (...args) => { providerCalls.push(["sleep", ...args]) },
        sleepUntil: async (...args) => { providerCalls.push(["sleepUntil", ...args]) },
      },
    })).resolves.toBe("rested")

    expect(providerCalls).toEqual([["sleep", "sleep-1", 1_000], ["sleepUntil", "sleep-2", new Date(until)]])
    expect(calls).toEqual(["before", "middle", "after"])
  })

  it("passes a duration string to Cloudflare as milliseconds", async () => {
    const sleep = vi.fn(async () => {})

    await runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1" },
      name: "nap",
      registry: { nap: async () => ({ default: napInFolder }) },
      step: { do: async (_name, _options, run) => await run(), sleep },
    })

    expect(sleep).toHaveBeenCalledWith("sleep-1", 1_000)
    expect(calls).toEqual(["before", "after"])
  })
})

describe("inline runs (vite dev and Vercel handlers)", () => {
  afterEach(() => {
    setWorkflowDevRecorder(undefined)
  })

  it("fails a root step that sleeps with the same code", async () => {
    setWorkflowRuntimeConfig({ driver: "vercel" })
    setWorkflowRuntimeRegistry({ nap: async () => ({ default: napInRootStep }) })

    const started = await unwrap(startWorkflow("nap"))

    await vi.waitFor(async () => {
      await expect(unwrap(getWorkflowRun("nap", started.id))).resolves.toMatchObject({ status: "failed", error: rootStepSleep })
    })
    expect(calls).toEqual(["before"])
  })

  it("waits with a timer in a folder Workflow, and records the sleep as a dev step", async () => {
    enableWorkflowDevRuns()
    setWorkflowRuntimeConfig({ driver: "vercel" })
    setWorkflowRuntimeRegistry({ nap: async () => ({ default: napTwiceInFolder }) })

    const startedAt = Date.now()
    const started = await unwrap(startWorkflow("nap", { until: new Date(startedAt + 1_200).toISOString() }))

    await delay(500)
    await expect(unwrap(getWorkflowRun("nap", started.id))).resolves.toMatchObject({ status: "running" })
    expect(calls).toEqual(["before"])

    await vi.waitFor(async () => {
      await expect(unwrap(getWorkflowRun("nap", started.id))).resolves.toMatchObject({ status: "completed", result: "rested" })
    }, { timeout: 3_000 })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_150)
    expect(calls).toEqual(["before", "middle", "after"])
    expect(getWorkflowDevRecorder()!.list()[0]!.steps.map(step => [step.name, step.status])).toEqual([["sleep-1", "completed"], ["sleep-2", "completed"]])
  })

  it("splits a wait longer than the largest timer, so it does not end at once", async () => {
    vi.useFakeTimers()
    try {
      setWorkflowRuntimeConfig({ driver: "vercel" })
      setWorkflowRuntimeRegistry({ nap: async () => ({ default: folderWorkflow<undefined>(async (context) => { await context.sleep("30 days"); return "rested" }) }) })
      const started = await unwrap(startWorkflow("nap"))

      await vi.advanceTimersByTimeAsync(29 * 24 * 60 * 60 * 1_000)
      await expect(unwrap(getWorkflowRun("nap", started.id))).resolves.toMatchObject({ status: "running" })
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
      await expect(unwrap(getWorkflowRun("nap", started.id))).resolves.toMatchObject({ status: "completed", result: "rested" })
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe("OpenWorkflow (SQLite)", () => {
  beforeEach(() => {
    setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      nap: async () => ({ default: napInRootStep }),
      folderNap: async () => ({ default: napInFolder }),
      folderNapTwice: async () => ({ default: napTwiceInFolder }),
    })
  })

  afterEach(async () => {
    await resetOpenWorkflowRuntime()
  })

  async function tick(): Promise<void> {
    const worker = await createOpenWorkflowWorker()
    await worker.tick()
    await worker.stop()
  }

  it("fails a root step that sleeps at once, without a retry", async () => {
    const started = await unwrap(startWorkflow("nap"))

    await tick()

    await expect(unwrap(getWorkflowRun("nap", started.id))).resolves.toMatchObject({ status: "failed" })
    expect(calls).toEqual(["before"])
  })

  it("wakes a folder Workflow after `context.sleep()`", async () => {
    const started = await unwrap(startWorkflow("folderNap"))

    await tick()
    const sleeping = await unwrap(getWorkflowRun("folderNap", started.id))
    expect(sleeping).toMatchObject({ status: "running", steps: [{ name: "sleep-1", status: "running", sleepUntil: expect.any(Date) }] })

    await delay(1100)
    await tick()

    await expect(unwrap(getWorkflowRun("folderNap", started.id))).resolves.toMatchObject({
      status: "completed",
      steps: [{ name: "sleep-1", status: "completed", sleepUntil: sleeping.steps![0]!.sleepUntil }],
    })
    // OpenWorkflow runs the orchestrator again from the start after the sleep. Code outside step files runs again.
    expect(calls).toEqual(["before", "before", "after"])
  })

  it("sleeps until a date, and a replay does not sleep again", async () => {
    const until = new Date(Date.now() + 1_500)
    const started = await unwrap(startWorkflow("folderNapTwice", { until: until.toISOString() }))

    await tick()
    await delay(1_100)
    await tick()
    const sleeping = await unwrap(getWorkflowRun("folderNapTwice", started.id))
    expect(sleeping).toMatchObject({ status: "running", steps: [{ name: "sleep-1", status: "completed" }, { name: "sleep-2", status: "running" }] })
    // OpenWorkflow keeps a wake time to the millisecond. It is the date, not "now" plus a duration of a later replay.
    expect(Math.abs(sleeping.steps![1]!.sleepUntil!.getTime() - until.getTime())).toBeLessThan(50)

    await delay(Math.max(0, until.getTime() - Date.now()) + 100)
    await tick()

    await expect(unwrap(getWorkflowRun("folderNapTwice", started.id))).resolves.toMatchObject({ status: "completed", result: "rested" })
    expect(calls).toEqual(["before", "before", "middle", "before", "middle", "after"])
  })
})
