import { afterEach, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { createWorkflow, getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => {
  resetWorkflowRuntime()
  vi.unstubAllEnvs()
})

// The instance id rules of a Cloudflare Workflow binding, as Miniflare and the Cloudflare limits page define them.
function isValidInstanceId(id: string) {
  return id.length <= 100 && /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/.test(id)
    && !["batch", "terminate", "terminateAll"].includes(id) && !/^cf_[0-9a-f]{64}$/.test(id)
}

function invalidId() {
  return new Error("(instance.invalid_id) Instance ID is invalid")
}

function cloudflareBinding(name: string) {
  const instances = new Map<string, unknown>()
  const binding = {
    createBatch: vi.fn(async (batch: { id: string, params: unknown }[]) => batch.map(({ id, params }) => {
      if (!isValidInstanceId(id)) throw invalidId()
      instances.set(id, params)
      return { id, status: async () => ({ status: "queued" }) }
    })),
    get: vi.fn(async (id: string) => {
      if (!isValidInstanceId(id)) throw invalidId()
      if (!instances.has(id)) throw new Error("instance.not_found")
      return { id, status: async () => ({ status: "running" }) }
    }),
  }
  setWorkflowRuntimeConfig({ provider: "cloudflare" })
  setWorkflowRuntimeRegistry({ [name]: async () => ({ default: { handler: async () => ({ ok: true }) } }) })
  enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: { [getCloudflareWorkflowBindingName(name)]: binding } } } } })
  return binding
}

it.each([
  { id: "checkout:1042", label: "a colon" },
  { id: "-checkout-1042", label: "a leading hyphen" },
  { id: `checkout-${"x".repeat(92)}`, label: "101 characters" },
  { id: "terminateAll", label: "a reserved id" },
])("rejects a run id with $label before Cloudflare sees it", async ({ id }) => {
  const binding = cloudflareBinding("checkout")

  await expect(startWorkflow("checkout", { orderId: "1042" }, { id })).rejects.toMatchObject({
    code: "WORKFLOW_R0037",
    message: expect.stringContaining("up to 100 characters"),
  })
  expect(binding.createBatch).not.toHaveBeenCalled()
})

it("starts and reads a run with an id that Cloudflare accepts", async () => {
  cloudflareBinding("checkout")

  await expect(startWorkflow("checkout", { orderId: "1042" }, { id: "checkout-1042" })).resolves.toMatchObject({ id: "checkout-1042", status: "queued" })
  await expect(getWorkflowRun("checkout", "checkout-1042")).resolves.toMatchObject({ id: "checkout-1042", status: "running" })
})

it("reports a run id that Cloudflare rejects as unknown", async () => {
  const binding = cloudflareBinding("checkout")

  await expect(getWorkflowRun("checkout", "checkout:1042")).resolves.toEqual({ id: "checkout:1042", provider: "cloudflare", status: "unknown" })
  expect(binding.get).not.toHaveBeenCalled()
})

it("rejects the id in vite dev, where the run is inline", async () => {
  vi.stubEnv("NODE_ENV", "production")
  enableWorkflowDevRuns()
  setWorkflowRuntimeConfig({ provider: "cloudflare" })
  setWorkflowRuntimeRegistry({ checkout: async () => ({ default: { handler: async () => ({ ok: true }) } }) })
  enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: {} } } } })

  await expect(startWorkflow("checkout", {}, { id: "checkout:1042" })).rejects.toMatchObject({ code: "WORKFLOW_R0037" })
})

it("derives a Cloudflare instance id from createWorkflow({ id }) for a long Workflow name", async () => {
  const name = `n${"a".repeat(99)}`
  const binding = cloudflareBinding(name)
  const workflow = createWorkflow<{ orderId: string }>(name, { id: ({ payload }) => payload?.orderId ?? "" })

  const run = await workflow.start({ orderId: "1042" })
  expect(run.id.length).toBeLessThanOrEqual(100)
  expect(binding.createBatch).toHaveBeenCalledWith([{ id: run.id, params: { orderId: "1042" } }])
})
