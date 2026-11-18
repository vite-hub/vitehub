import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { onRunFailed } from "@vite-hub/runtime/internal/run-failed"

import { createWorkflow, getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { createWorkflowSteps } from "../src/runtime/execute.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

import type { RunFailedEvent } from "@vite-hub/runtime/internal/run-failed"
import type { WorkflowProviderStep } from "../src/types.ts"

let events: RunFailedEvent[] = []
let stop: () => void

beforeEach(async () => {
  resetWorkflowRuntime()
  await resetOpenWorkflowRuntime()
  events = []
  stop = onRunFailed((event) => {
    events.push(event)
  })
})

afterEach(async () => {
  stop()
  await resetOpenWorkflowRuntime()
})

it("sends workflow.failed when an inline run fails", async () => {
  setWorkflowRuntimeConfig({ driver: "vercel" })
  const workflow = createWorkflow("charge-card", async () => {
    throw Object.assign(new TypeError("card declined"), { code: "CARD_DECLINED" })
  })

  await workflow.start({}, { id: "inline-1" })
  await vi.waitFor(async () => expect((await workflow.getRun("inline-1")).status).toBe("failed"))

  expect(events).toEqual([{ event: "workflow.failed", workflow: "charge-card", runId: "inline-1", error: { message: "card declined", code: "CARD_DECLINED" }, failedAt: expect.any(String) }])
})

it("sends workflow.failed when a Cloudflare instance ends with an error", async () => {
  const step = { do: async (_name: string, _options: unknown, run: () => unknown) => await run() } as WorkflowProviderStep
  await expect(runCloudflareWorkflow({
    config: { driver: "cloudflare" },
    env: {},
    event: { instanceId: "cf-1" },
    name: "import-orders",
    registry: { "import-orders": async () => ({ default: { handler: async () => { throw new Error("CSV is empty") } } }) },
    step,
  })).rejects.toThrow("CSV is empty")

  expect(events).toEqual([expect.objectContaining({ event: "workflow.failed", workflow: "import-orders", runId: "cf-1", error: { message: "CSV is empty" } })])
})

it("skips the internal Workflow of an Agent turn, which reports invocation.failed instead", async () => {
  setWorkflowRuntimeConfig({ driver: "vercel" })
  // The Agent package marks its turn Workflow with this flag.
  const workflow = createWorkflow("agent-turn", async () => {
    throw new Error("model down")
  }, { internalAgentWorkflow: true })

  await workflow.start({}, { id: "turn-1" })
  await vi.waitFor(async () => expect((await workflow.getRun("turn-1")).status).toBe("failed"))

  expect(events).toEqual([])
})

it("sends workflow.failed for an OpenWorkflow run only when no retry is left", async () => {
  let failStep = true
  setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
  setWorkflowRuntimeRegistry({
    "onboard-user": async () => ({
      handler: async (payload: unknown, context: Parameters<typeof createWorkflowSteps>[0]) => {
        const steps = createWorkflowSteps(context, [{
          name: "01.create-user.ts",
          run: () => {
            if (failStep) throw new Error("The user store is down.")
            return { id: "user-1" }
          },
        }])
        return await steps.createUser!(payload)
      },
      options: { rootStep: false },
    }),
    "send-digest": async () => ({
      handler: async () => {
        throw new Error("SMTP timeout")
      },
      options: { rootStep: false },
    }),
  })

  const retried = await startWorkflow("onboard-user", {})
  const failed = await startWorkflow("send-digest", {})
  const worker = await createOpenWorkflowWorker()
  await worker.tick()
  await worker.stop()

  // The failed step waits for its retry, so only the Workflow that failed outside a step ended.
  expect((await getWorkflowRun("onboard-user", retried.id)).status).not.toBe("failed")
  expect((await getWorkflowRun("send-digest", failed.id)).status).toBe("failed")
  expect(events).toEqual([expect.objectContaining({ event: "workflow.failed", workflow: "send-digest", runId: failed.id, error: expect.objectContaining({ message: "SMTP timeout" }) })])
  failStep = false
})
