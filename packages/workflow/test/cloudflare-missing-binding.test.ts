import { afterEach, expect, it, vi } from "vitest"

import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => {
  resetWorkflowRuntime()
  vi.unstubAllEnvs()
})

function cloudflareWorkerWithoutBinding(handler = vi.fn(async () => ({ ok: true }))) {
  setWorkflowRuntimeConfig({ provider: "cloudflare" })
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

  await expect(startWorkflow("welcome", { name: "Ada" }, { id: "run-1" })).resolves.toMatchObject({ provider: "cloudflare", status: "queued" })
})
