import { afterEach, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { cancelWorkflow } from "../src/runtime/client.ts"
import { runWorkflowOperation } from "../src/runtime/operations.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => {
  resetWorkflowRuntime()
  vi.unstubAllEnvs()
})

/** A fake Cloudflare Workflow binding. `terminate()` throws on a finished instance, as Cloudflare does. */
function cloudflareBinding(statuses: Record<string, string>, options: { terminate?: (id: string) => Promise<void> } = {}) {
  const terminate = vi.fn(options.terminate ?? (async (id: string) => {
    if (["complete", "errored", "terminated"].includes(statuses[id]!)) {
      throw new Error("(instance.cannot_terminate) Cannot terminate instance since its on a finite state")
    }
    statuses[id] = "terminated"
  }))
  const binding = {
    createBatch: vi.fn(),
    get: vi.fn(async (id: string) => {
      if (!Object.hasOwn(statuses, id)) throw new Error("(instance.not_found) Instance not found")
      return { id, status: async () => ({ status: statuses[id] }), terminate: () => terminate(id) }
    }),
  }
  setWorkflowRuntimeConfig({ driver: "cloudflare" })
  setWorkflowRuntimeRegistry({ checkout: async () => ({ default: { handler: async () => ({ ok: true }) } }) })
  enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: { [getCloudflareWorkflowBindingName("checkout")]: binding } } } } })
  return { binding, statuses, terminate }
}

it.each(["queued", "running", "waiting", "paused"])("terminates a %s run and reports it cancelled", async (status) => {
  const { terminate } = cloudflareBinding({ "checkout-1": status })

  await expect(cancelWorkflow("checkout", "checkout-1")).resolves.toMatchObject({
    id: "checkout-1",
    metadata: { status: "terminated" },
    provider: "cloudflare",
    status: "cancelled",
  })
  expect(terminate).toHaveBeenCalledOnce()
})

it.each([
  ["complete", "completed"],
  ["errored", "failed"],
  ["terminated", "cancelled"],
])("returns a %s run unchanged without terminating it", async (status, expected) => {
  const { terminate } = cloudflareBinding({ "checkout-1": status })

  await expect(cancelWorkflow("checkout", "checkout-1")).resolves.toMatchObject({ id: "checkout-1", status: expected })
  expect(terminate).not.toHaveBeenCalled()
})

it("returns the finished run when it finishes before terminate() reaches it", async () => {
  const statuses: Record<string, string> = { "checkout-1": "running" }
  cloudflareBinding(statuses, {
    terminate: async () => {
      statuses["checkout-1"] = "complete"
      throw new Error("(instance.cannot_terminate) Cannot terminate instance since its on a finite state")
    },
  })

  await expect(cancelWorkflow("checkout", "checkout-1")).resolves.toMatchObject({ id: "checkout-1", status: "completed" })
})

it("reports a missing run as unknown, as the other providers do", async () => {
  const { terminate } = cloudflareBinding({})

  await expect(cancelWorkflow("checkout", "missing")).resolves.toEqual({ id: "missing", provider: "cloudflare", status: "unknown" })
  expect(terminate).not.toHaveBeenCalled()
})

it("fails when terminate() fails on a run that still runs", async () => {
  cloudflareBinding({ "checkout-1": "running" }, {
    terminate: async () => {
      throw Object.assign(new Error("Service unavailable"), { status: 503 })
    },
  })

  await expect(cancelWorkflow("checkout", "checkout-1")).rejects.toMatchObject({
    code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
    details: { operation: "cancel", provider: "cloudflare" },
  })
})

it("cancels through the workflow.cancel operation that `vitehub workflow cancel` calls", async () => {
  cloudflareBinding({ "checkout-1": "running" })

  await expect(runWorkflowOperation("cancel", { runId: "checkout-1", workflow: "checkout" })).resolves.toMatchObject({
    run: { id: "checkout-1", status: "cancelled" },
  })
})

it("reports inline cancellation as unsupported when the dev server has no binding", async () => {
  vi.stubEnv("NODE_ENV", "development")
  setWorkflowRuntimeConfig({ driver: "cloudflare" })
  setWorkflowRuntimeRegistry({ checkout: async () => ({ default: { handler: async () => ({ ok: true }) } }) })

  await expect(cancelWorkflow("checkout", "checkout-1")).rejects.toMatchObject({
    code: "WORKFLOW_OPERATION_UNSUPPORTED",
    details: { operation: "cancellation", provider: "cloudflare" },
  })
})
