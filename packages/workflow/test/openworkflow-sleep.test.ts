import { setTimeout as delay } from "node:timers/promises"

import { afterEach, beforeEach, expect, it } from "vitest"

import { defineWorkflow } from "../src/definition.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

const calls: string[] = []

beforeEach(() => {
  resetWorkflowRuntime()
  calls.length = 0
  setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
  // A single-file Workflow: the registry imports the module as it is, so the handler keeps its root step.
  setWorkflowRuntimeRegistry({
    nap: async () => ({
      default: defineWorkflow("nap", async (_payload: undefined, context) => {
        calls.push("before")
        await context.step?.sleep?.("nap", "1 second")
        calls.push("after")
        return "rested"
      }),
    }),
    flaky: async () => ({
      default: defineWorkflow("flaky", async () => {
        throw new Error("The API is down.")
      }),
    }),
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

it("wakes a single-file Workflow after `context.step.sleep()`, not after the retry delay", async () => {
  const started = await startWorkflow("nap")

  await tick()
  await expect(getWorkflowRun("nap", started.id)).resolves.toMatchObject({ status: "running" })

  await delay(1100)
  await tick()

  await expect(getWorkflowRun("nap", started.id)).resolves.toMatchObject({ status: "completed" })
  expect(calls).toEqual(["before", "before", "after"])
})

it("still retries a single-file Workflow that throws, like its root step did", async () => {
  const started = await startWorkflow("flaky")

  await tick()

  await expect(getWorkflowRun("flaky", started.id)).resolves.toMatchObject({ status: "queued" })
})
