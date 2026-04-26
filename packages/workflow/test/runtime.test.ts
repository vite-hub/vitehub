import { beforeEach, describe, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
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

  it("uses Nitro request waitUntil for deferred Cloudflare workflow dispatch", async () => {
    const create = vi.fn(async ({ id }: { id: string }) => ({
      id,
      status: vi.fn(async () => ({ status: "queued" })),
    }))
    const waitUntil = vi.fn()

    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: async () => ({ ok: true }),
        },
      }),
    })
    enterWorkflowRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            env: {
              [getCloudflareWorkflowBindingName("welcome")]: {
                create,
                get: vi.fn(),
              },
            },
          },
        },
        waitUntil,
      },
    })

    deferWorkflow("welcome", { id: "welcome-1", payload: { email: "ava@example.com" } })

    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    expect(create).toHaveBeenCalledWith({
      id: "welcome-1",
      params: { email: "ava@example.com" },
    })
  })
})
