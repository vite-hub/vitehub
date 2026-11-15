import { afterEach, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { createWorkflow, getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => {
  resetWorkflowRuntime()
  vi.unstubAllEnvs()
})

// The array-form createBatch accepts the same ids as create(), including reserved ids.
function isValidInstanceId(id: string) {
  return id.length <= 100 && /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/.test(id)
}

function invalidId() {
  return new Error("(instance.invalid_id) Instance ID is invalid")
}

function cloudflareBinding(name: string, existingIds: string[] = []) {
  const instances = new Map<string, unknown>(existingIds.map(id => [id, undefined]))
  const binding = {
    createBatch: vi.fn(async (batch: { id: string, params: unknown }[]) => batch.map(({ id, params }) => {
      if (!isValidInstanceId(id)) throw invalidId()
      instances.set(id, params)
      return { id, status: async () => ({ status: "queued" }) }
    })),
    get: vi.fn(async (id: string) => {
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
])("rejects a run id with $label before Cloudflare sees it", async ({ id }) => {
  const binding = cloudflareBinding("checkout")

  await expect(startWorkflow("checkout", { orderId: "1042" }, { id })).rejects.toMatchObject({
    code: "WORKFLOW_CLOUDFLARE_RUN_ID_INVALID",
    message: expect.stringContaining("up to 100 characters"),
  })
  expect(binding.createBatch).not.toHaveBeenCalled()
})

it("starts and reads a run with an id that Cloudflare accepts", async () => {
  cloudflareBinding("checkout")

  await expect(startWorkflow("checkout", { orderId: "1042" }, { id: "checkout-1042" })).resolves.toMatchObject({ id: "checkout-1042", status: "queued" })
  await expect(getWorkflowRun("checkout", "checkout-1042")).resolves.toMatchObject({ id: "checkout-1042", status: "running" })
})

it.each(["batch", "terminate", "terminateAll", "cf_" + "a".repeat(64)])("starts and inspects supported reserved id %s", async (id) => {
  const binding = cloudflareBinding("checkout")
  await expect(startWorkflow("checkout", {}, { id })).resolves.toMatchObject({ id, status: "queued" })
  await expect(getWorkflowRun("checkout", id)).resolves.toMatchObject({ id, status: "running" })
  expect(binding.get).toHaveBeenCalledWith(id)
})

it("inspects an existing cron-generated instance id", async () => {
  const id = "*/30 * * * *-1786001400000"
  const binding = cloudflareBinding("checkout", [id])
  await expect(getWorkflowRun("checkout", id)).resolves.toMatchObject({ id, status: "running" })
  expect(binding.get).toHaveBeenCalledWith(id)
})

it("reports a missing instance as unknown after querying the binding", async () => {
  const binding = cloudflareBinding("checkout")
  await expect(getWorkflowRun("checkout", "checkout:1042")).resolves.toEqual({ id: "checkout:1042", provider: "cloudflare", status: "unknown" })
  expect(binding.get).toHaveBeenCalledWith("checkout:1042")
})

it("rejects the id in vite dev, where the run is inline", async () => {
  vi.stubEnv("NODE_ENV", "production")
  enableWorkflowDevRuns()
  setWorkflowRuntimeConfig({ provider: "cloudflare" })
  setWorkflowRuntimeRegistry({ checkout: async () => ({ default: { handler: async () => ({ ok: true }) } }) })
  enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: {} } } } })

  await expect(startWorkflow("checkout", {}, { id: "checkout:1042" })).rejects.toMatchObject({ code: "WORKFLOW_CLOUDFLARE_RUN_ID_INVALID" })
})

it("derives a Cloudflare instance id from createWorkflow({ id }) for a long Workflow name", async () => {
  const name = `n${"a".repeat(99)}`
  const binding = cloudflareBinding(name)
  const workflow = createWorkflow<{ orderId: string }>(name, { id: ({ payload }) => payload?.orderId ?? "" })

  const run = await workflow.start({ orderId: "1042" })
  expect(run.id.length).toBeLessThanOrEqual(100)
  expect(binding.createBatch).toHaveBeenCalledWith([{ id: run.id, params: { orderId: "1042" } }])
})
