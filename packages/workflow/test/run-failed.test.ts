import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { onRunFailed } from "@vite-hub/runtime/internal/run-failed"

import { createWorkflow, getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { createWorkflowSteps } from "../src/runtime/execute.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { unwrap } from "./unwrap.ts"

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

  const gate = Promise.withResolvers<void>()
  const listener = vi.fn(() => gate.promise)
  const unsubscribe = onRunFailed(listener)
  const wake = vi.fn<(task: Promise<unknown>) => void>()
  try {
    await runWithWorkflowRuntimeEvent({ waitUntil: wake }, () => unwrap(workflow.start({}, { id: "inline-1" })))
    await vi.waitFor(async () => expect((await unwrap(workflow.getRun("inline-1"))).status).toBe("failed"))
    expect(listener).toHaveBeenCalledOnce()
    expect(wake).toHaveBeenCalledOnce()
    expect(events).toEqual([{ event: "workflow.failed", workflow: "charge-card", runId: "inline-1", error: { message: "card declined", code: "CARD_DECLINED" }, failedAt: expect.any(String) }])
  }
  finally {
    gate.resolve()
    await wake.mock.calls[0]?.[0]
    unsubscribe()
  }
})

it("sends workflow.failed once when Cloudflare replays a failed instance", async () => {
  const checkpoints = new Map<string, unknown>()
  const step: WorkflowProviderStep = {
    async do<TResult>(name: string, _options: unknown, run: () => TResult | Promise<TResult>): Promise<TResult> {
      if (checkpoints.has(name)) return structuredClone(checkpoints.get(name)) as TResult
      const result = await run()
      checkpoints.set(name, result)
      return result
    },
  }
  const handler = vi.fn(async () => { throw new Error("CSV is empty") })
  const run = () => runCloudflareWorkflow({
    config: { driver: "cloudflare" },
    env: {},
    event: { instanceId: "cf-1" },
    name: "import-orders",
    registry: { "import-orders": async () => ({ handler, options: { rootStep: false } }) },
    step,
  })
  await expect(run()).rejects.toThrow("CSV is empty")
  await expect(run()).rejects.toThrow("CSV is empty")

  expect(events).toEqual([expect.objectContaining({ event: "workflow.failed", workflow: "import-orders", runId: "cf-1", error: { message: "CSV is empty" } })])
})

it("skips the internal Workflow of an Agent turn, which reports invocation.failed instead", async () => {
  setWorkflowRuntimeConfig({ driver: "vercel" })
  // The Agent package marks its turn Workflow with this flag.
  const workflow = createWorkflow("agent-turn", async () => {
    throw new Error("model down")
  }, { internalAgentWorkflow: true })

  await unwrap(workflow.start({}, { id: "turn-1" }))
  await vi.waitFor(async () => expect((await unwrap(workflow.getRun("turn-1"))).status).toBe("failed"))

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

  const retried = await unwrap(startWorkflow("onboard-user", {}))
  const failed = await unwrap(startWorkflow("send-digest", {}))
  const worker = await createOpenWorkflowWorker()
  await worker.tick()
  await worker.stop()

  // The failed step waits for its retry, so only the Workflow that failed outside a step ended.
  expect((await unwrap(getWorkflowRun("onboard-user", retried.id))).status).not.toBe("failed")
  expect((await unwrap(getWorkflowRun("send-digest", failed.id))).status).toBe("failed")
  expect(events).toEqual([expect.objectContaining({ event: "workflow.failed", workflow: "send-digest", runId: failed.id, error: expect.objectContaining({ message: "SMTP timeout" }) })])
  failStep = false
})
