import { beforeEach, describe, expect, it, vi } from "vitest"

import { deferWorkflow, getWorkflowRun, runWorkflow } from "../src/runtime/client.ts"
import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

beforeEach(() => {
  setWorkflowRuntimeConfig(undefined)
  setWorkflowRuntimeRegistry(undefined)
  enterWorkflowRuntimeEvent(undefined)
})

describe("workflow runtime", () => {
  it("runs registered definitions through the Vercel provider", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: async ({ payload }) => ({ payload }),
        },
      }),
    })

    const run = await runWorkflow("welcome", { message: "hello" })
    expect(run).toMatchObject({ provider: "vercel", status: "queued" })

    await expect(getWorkflowRun("welcome", run.id)).resolves.toMatchObject({
      provider: "vercel",
      result: { payload: { message: "hello" } },
      status: "completed",
    })
  })

  it("throws for missing definitions", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({})

    const run = await runWorkflow("missing", {})
    await expect(getWorkflowRun("missing", run.id)).resolves.toMatchObject({
      status: "failed",
    })
  })

  it("uses waitUntil for deferred workflow dispatch", async () => {
    const waitUntil = vi.fn()
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: async () => ({ ok: true }),
        },
      }),
    })
    enterWorkflowRuntimeEvent({ waitUntil })

    deferWorkflow("welcome", {})

    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
  })
})
