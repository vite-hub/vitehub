import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { defineWorkflow } from "../src/definition.ts"
import { startWorkflow } from "../src/runtime/client.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

beforeEach(() => {
  resetWorkflowRuntime()
  setWorkflowRuntimeRegistry({
    checkout: async () => ({ default: defineWorkflow("checkout", async (payload: { order: number }) => payload) }),
  })
})

afterEach(async () => {
  await resetOpenWorkflowRuntime()
})

describe("a second start with the id of an existing run", () => {
  it("returns the stored OpenWorkflow run, not the new payload", async () => {
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })

    const first = await startWorkflow("checkout", { order: 1 }, { id: "checkout-1" })
    const second = await startWorkflow("checkout", { order: 2 }, { id: "checkout-1" })

    expect(second.id).toBe(first.id)
    expect(second.payload).toEqual({ order: 1 })
  })

  it("returns the state of the existing Cloudflare instance, not the new payload", async () => {
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CHECKOUT", provider: "cloudflare" })
    // Miniflare 5.20261104: `createBatch` returns no instance for an id that exists.
    const instances = new Map<string, { status: string }>([["checkout-1", { status: "running" }]])
    enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: { WORKFLOW_CHECKOUT: {
        createBatch: async (batch: Array<{ id: string }>) => batch.filter(({ id }) => !instances.has(id)),
        get: async (id: string) => ({ id, status: async () => instances.get(id) }),
      } } } } },
    })

    const second = await startWorkflow("checkout", { order: 2 }, { id: "checkout-1" })

    expect(second).toMatchObject({ id: "checkout-1", provider: "cloudflare", status: "running" })
    expect(second.payload).toBeUndefined()
  })

  it("still reports a new Cloudflare instance as queued with its payload", async () => {
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CHECKOUT", provider: "cloudflare" })
    enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: { WORKFLOW_CHECKOUT: {
        createBatch: async (batch: Array<{ id: string }>) => batch.map(({ id }) => ({ id })),
        get: async (id: string) => ({ id }),
      } } } } },
    })

    await expect(startWorkflow("checkout", { order: 3 }, { id: "checkout-3" })).resolves.toEqual({
      id: "checkout-3",
      payload: { order: 3 },
      provider: "cloudflare",
      status: "queued",
    })
  })
})
