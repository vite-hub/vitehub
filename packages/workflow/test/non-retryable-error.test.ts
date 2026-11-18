import { setTimeout as delay } from "node:timers/promises"
import { runInNewContext } from "node:vm"

import { FatalError } from "workflow"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkflowDefinition, WorkflowProviderStep } from "../src/types.ts"
import { defineWorkflow } from "../src/definition.ts"
import { NonRetryableError } from "../src/index.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { createWorkflowSteps } from "../src/runtime/execute.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

const calls: string[] = []
const caught: unknown[] = []

/** A single-file Workflow: the handler runs in the root step. */
const declineInRootStep = defineWorkflow("decline", async () => {
  calls.push("charge")
  throw new NonRetryableError("card declined")
})

/** The shape that the generated registry gives a folder Workflow without `index.ts`. */
const declineInStepFile: WorkflowDefinition = {
  options: { rootStep: false },
  handler: async (payload, context) => {
    const steps = createWorkflowSteps(context, [
      {
        name: "01.charge.ts",
        run: () => {
          calls.push("charge")
          throw new NonRetryableError("card declined", { cause: new Error("issuer said no") })
        },
      },
      { name: "02.ship.ts", run: () => calls.push("ship") },
    ])
    let value = payload
    for (const step of Object.values(steps)) value = await step(value)
    return value
  },
}

/** A folder Workflow whose `index.ts` catches the error, then sleeps, so OpenWorkflow replays it. */
const refundAfterDecline: WorkflowDefinition = {
  options: { rootStep: false },
  handler: async (_payload, context) => {
    const steps = createWorkflowSteps(context, [{
      name: "01.charge.ts",
      run: () => {
        calls.push("charge")
        throw new NonRetryableError("card declined")
      },
    }])
    try {
      await steps.charge!(undefined)
    }
    catch (error) {
      caught.push(error)
    }
    await context.sleep(200)
    return "refunded"
  },
}

beforeEach(() => {
  resetWorkflowRuntime()
  calls.length = 0
  caught.length = 0
})

describe("NonRetryableError", () => {
  it("has the fields that Cloudflare and Workflow DevKit read", () => {
    const cause = new Error("issuer said no")
    const error = new NonRetryableError("card declined", { cause })

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ cause, fatal: true, isRetryable: false, message: "card declined", name: "NonRetryableError" })
  })

  it("is a FatalError for the installed Workflow DevKit, so a Vercel step does not retry", () => {
    expect(FatalError.is(new NonRetryableError("card declined"))).toBe(true)
  })
})

describe("Cloudflare", () => {
  /** Cloudflare retries a step that throws, unless the error is its own NonRetryableError. */
  class CloudflareNonRetryableError extends Error {}
  function cloudflareStep(): WorkflowProviderStep {
    return {
      do: async (_name, _options, run) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await run()
          }
          catch (error) {
            if (error instanceof CloudflareNonRetryableError || attempt === 3) throw error
          }
        }
      },
    }
  }

  it.each([
    ["a step file", declineInStepFile],
    ["a root step", declineInRootStep],
  ])("stops the retries of %s", async (_label, definition) => {
    const createNonRetryableError = vi.fn((error: Error) => new CloudflareNonRetryableError(error.message))

    await expect(runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      createNonRetryableError,
      env: {},
      event: { instanceId: "run-1" },
      name: "decline",
      registry: { decline: async () => ({ default: definition }) },
      step: cloudflareStep(),
    })).rejects.toThrow(CloudflareNonRetryableError)

    expect(calls).toEqual(["charge"])
    expect(createNonRetryableError).toHaveBeenCalledWith(expect.objectContaining({ message: "card declined", name: "NonRetryableError" }))
  })

  it("finds the error by its name when it comes from another bundle without `isRetryable`", async () => {
    // SAFETY: The VM fixture creates an error from another realm, as a second copy of the package can.
    const foreign = runInNewContext("Object.assign(new Error('card declined'), { name: 'NonRetryableError' })") as Error
    const createNonRetryableError = vi.fn((error: Error) => new CloudflareNonRetryableError(error.message))

    await expect(runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      createNonRetryableError,
      env: {},
      event: { instanceId: "run-1" },
      name: "decline",
      registry: { decline: async () => ({ default: { handler: () => { calls.push("charge"); throw foreign } } }) },
      step: cloudflareStep(),
    })).rejects.toThrow(CloudflareNonRetryableError)

    expect(calls).toEqual(["charge"])
  })
})

describe("Inline runs", () => {
  it.each([
    ["a step file", declineInStepFile],
    ["a root step", declineInRootStep],
  ])("fail at once from %s and report the message", async (_label, definition) => {
    setWorkflowRuntimeConfig({ driver: "vercel" })
    setWorkflowRuntimeRegistry({ decline: async () => ({ default: definition }) })

    const started = await startWorkflow("decline")

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("decline", started.id)).resolves.toMatchObject({
        error: { message: "card declined", name: "NonRetryableError" },
        status: "failed",
      })
    })
    expect(calls).toEqual(["charge"])
  })
})

describe("OpenWorkflow (SQLite)", () => {
  beforeEach(() => {
    setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      decline: async () => ({ default: declineInRootStep }),
      declineInStep: async () => ({ default: declineInStepFile }),
      refund: async () => ({ default: refundAfterDecline }),
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

  it("fails the run at once when a step file throws it, and reports the step as failed", async () => {
    const started = await startWorkflow("declineInStep")

    await tick()
    await tick()

    const run = await getWorkflowRun("declineInStep", started.id)
    expect(run).toMatchObject({ error: { message: "card declined", name: "NonRetryableError" }, status: "failed" })
    expect(run.steps).toEqual([
      expect.objectContaining({ attempt: 1, error: { message: "card declined" }, name: "declineInStep/01.charge.ts", status: "failed" }),
    ])
    expect(calls).toEqual(["charge"])
  })

  it("fails the run at once when a single-file handler throws it", async () => {
    const started = await startWorkflow("decline")

    await tick()
    await tick()

    await expect(getWorkflowRun("decline", started.id)).resolves.toMatchObject({
      error: { message: "card declined", name: "NonRetryableError" },
      status: "failed",
    })
    expect(calls).toEqual(["charge"])
  })

  it("throws the same error again on replay, without running the step again", async () => {
    const started = await startWorkflow("refund")

    await tick()
    await expect(getWorkflowRun("refund", started.id)).resolves.toMatchObject({ status: "running" })

    await delay(300)
    await tick()

    await expect(getWorkflowRun("refund", started.id)).resolves.toMatchObject({ result: "refunded", status: "completed" })
    expect(calls).toEqual(["charge"])
    expect(caught).toHaveLength(2)
    for (const error of caught) {
      expect(error).toBeInstanceOf(NonRetryableError)
      expect(error).toMatchObject({ isRetryable: false, message: "card declined", name: "NonRetryableError" })
    }
  })
})
