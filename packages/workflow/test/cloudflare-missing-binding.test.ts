import { afterEach, expect, it, vi } from "vitest"

import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { unwrap } from "./unwrap.ts"

afterEach(() => {
  resetWorkflowRuntime()
  vi.unstubAllEnvs()
})

function cloudflareWorkerWithoutBinding(handler = vi.fn(async () => ({ ok: true }))) {
  setWorkflowRuntimeConfig({ driver: "cloudflare" })
  setWorkflowRuntimeRegistry({ welcome: async () => ({ default: { handler } }) })
  enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: { OTHER: "value" } } } } })
  return handler
}

it("fails to start or read a run without the binding outside a development server", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const handler = cloudflareWorkerWithoutBinding()
  const missing = { code: "WORKFLOW_R0036", message: expect.stringContaining("\"WORKFLOW_77656C636F6D65\"") }

  await expect(startWorkflow("welcome", { name: "Ada" }, { id: "run-1" })).rejects.toMatchObject(missing)
  await expect(getWorkflowRun("welcome", "run-1")).rejects.toMatchObject(missing)
  expect(handler).not.toHaveBeenCalled()
})

it("runs the Workflow inline without the binding on a development server", async () => {
  vi.stubEnv("NODE_ENV", "production")
  enableWorkflowDevRuns()
  cloudflareWorkerWithoutBinding()

  await expect(unwrap(startWorkflow("welcome", { name: "Ada" }, { id: "run-1" }))).resolves.toMatchObject({ provider: "cloudflare", status: "queued" })
})

it("reports a failed dev run as failed after the inline run state expires", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  try {
    enableWorkflowDevRuns()
    const handler = cloudflareWorkerWithoutBinding(vi.fn(async () => {
      throw new Error("boom")
    }))
    await unwrap(startWorkflow("welcome", { name: "Ada" }, { id: "run-1" }))
    await vi.waitFor(async () => expect((await unwrap(getWorkflowRun("welcome", "run-1"))).status).toBe("failed"))

    // The dev server keeps its run history longer than the five minutes of the inline run state.
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    await expect(unwrap(getWorkflowRun("welcome", "run-1"))).resolves.toMatchObject({ error: { message: "boom" }, provider: "cloudflare", status: "failed" })
    // A second start with the same id returns that run and does not run the handler again.
    await expect(unwrap(startWorkflow("welcome", { name: "Ada" }, { id: "run-1" }))).resolves.toMatchObject({ provider: "cloudflare", status: "failed" })
    expect(handler).toHaveBeenCalledTimes(1)
  }
  finally {
    vi.useRealTimers()
  }
})
