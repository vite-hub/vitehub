import { setTimeout as delay } from "node:timers/promises"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkflowDefinition, WorkflowProviderStep } from "../src/types.ts"
import { defineWorkflow } from "../src/definition.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

const rootStepSleep = { code: "WORKFLOW_ROOT_STEP_SLEEP", message: expect.stringContaining("folder Workflow") }
const calls: string[] = []

/** A single-file Workflow: the handler runs in the root step. */
const napInRootStep = defineWorkflow("nap", async (_payload: undefined, context) => {
  calls.push("before")
  await context.step!.sleep!("nap", "1 second")
  calls.push("after")
  return "rested"
})

/** A folder Workflow orchestrator: the generated registry entry sets `rootStep: false`. */
const napInFolder: WorkflowDefinition<undefined, string> = {
  options: { rootStep: false },
  handler: async (_payload, context) => {
    calls.push("before")
    await context.step!.sleep!("nap", "1 second")
    calls.push("after")
    return "rested"
  },
}

beforeEach(() => {
  resetWorkflowRuntime()
  calls.length = 0
})

describe("Cloudflare", () => {
  it("fails a root step that sleeps, and does not call the provider sleep", async () => {
    const sleep = vi.fn(async () => {})
    const step: WorkflowProviderStep = { do: vi.fn(async (_name, _options, run) => await run()), sleep }

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
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
      config: { provider: "cloudflare" },
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

  it("lets a folder Workflow sleep", async () => {
    const sleep = vi.fn(async () => {})

    await runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      env: {},
      event: { instanceId: "run-1" },
      name: "nap",
      registry: { nap: async () => ({ default: napInFolder }) },
      step: { do: async (_name, _options, run) => await run(), sleep },
    })

    expect(sleep).toHaveBeenCalledWith("nap", "1 second")
    expect(calls).toEqual(["before", "after"])
  })
})

describe("Vercel and inline runs", () => {
  it("fails a root step that sleeps with the same code", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({ nap: async () => ({ default: napInRootStep }) })

    const started = await startWorkflow("nap")

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("nap", started.id)).resolves.toMatchObject({ status: "failed", error: rootStepSleep })
    })
    expect(calls).toEqual(["before"])
  })
})

describe("OpenWorkflow (SQLite)", () => {
  beforeEach(() => {
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      nap: async () => ({ default: napInRootStep }),
      folderNap: async () => ({ default: napInFolder }),
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
    const started = await startWorkflow("nap")

    await tick()

    await expect(getWorkflowRun("nap", started.id)).resolves.toMatchObject({ status: "failed" })
    expect(calls).toEqual(["before"])
  })

  it("wakes a folder Workflow after `context.step.sleep()`", async () => {
    const started = await startWorkflow("folderNap")

    await tick()
    await expect(getWorkflowRun("folderNap", started.id)).resolves.toMatchObject({ status: "running" })

    await delay(1100)
    await tick()

    await expect(getWorkflowRun("folderNap", started.id)).resolves.toMatchObject({ status: "completed" })
    // OpenWorkflow runs the orchestrator again from the start after the sleep. Code outside step files runs again.
    expect(calls).toEqual(["before", "before", "after"])
  })
})
