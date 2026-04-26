import { beforeEach, describe, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { deferWorkflow, getWorkflowRun, runWorkflow } from "../src/runtime/client.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

beforeEach(() => {
  resetWorkflowRuntime()
})

describe("workflow runtime", () => {
  it("runs registered definitions through the Vercel provider", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async ({ payload }) => ({ payload }) },
      }),
    })

    const run = await runWorkflow("welcome", { message: "hello" })
    expect(run).toMatchObject({ provider: "vercel", status: "queued" })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("welcome", run.id)).resolves.toMatchObject({
        provider: "vercel",
        result: { payload: { message: "hello" } },
        status: "completed",
      })
    })
  })

  it("throws for missing definitions", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({})

    await expect(runWorkflow("missing", {})).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
    })
  })

  it("returns nonblocking status while local workflow runs are pending", async () => {
    let resolveRun: ((value: { ok: boolean }) => void) | undefined
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: () => new Promise(resolve => {
            resolveRun = resolve
          }),
        },
      }),
    })

    const run = await runWorkflow("welcome", {})
    await expect(getWorkflowRun("welcome", run.id)).resolves.toMatchObject({ status: "running" })

    resolveRun?.({ ok: true })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("welcome", run.id)).resolves.toMatchObject({
        result: { ok: true },
        status: "completed",
      })
    })
    await expect(getWorkflowRun("welcome", run.id)).resolves.toMatchObject({
      result: { ok: true },
      status: "completed",
    })
  })

  it("scopes local workflow runs by name", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      one: async () => ({ default: { handler: async () => "one" } }),
      two: async () => ({ default: { handler: async () => "two" } }),
    })

    await runWorkflow("one", {}, { id: "shared" })
    await runWorkflow("two", {}, { id: "shared" })
    await Promise.resolve()

    await expect(getWorkflowRun("one", "shared")).resolves.toMatchObject({ result: "one" })
    await expect(getWorkflowRun("two", "shared")).resolves.toMatchObject({ result: "two" })
  })

  it("rejects invalid workflow module shapes as missing definitions", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ named: { handler: async () => ({ ok: true }) } }) as never,
    })

    await expect(runWorkflow("welcome", {})).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
    })
  })

  it("uses waitUntil for deferred workflow dispatch", async () => {
    const waitUntil = vi.fn()
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({ waitUntil })

    await deferWorkflow("welcome", {})

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
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            env: {
              [getCloudflareWorkflowBindingName("welcome")]: { create, get: vi.fn() },
            },
          },
        },
        waitUntil,
      },
    })

    await deferWorkflow("welcome", { email: "ava@example.com" }, { id: "welcome-1" })

    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    expect(create).toHaveBeenCalledWith({
      id: "welcome-1",
      params: { email: "ava@example.com" },
    })
  })
})
