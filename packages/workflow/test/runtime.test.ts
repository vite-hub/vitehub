import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { deferWorkflow, getWorkflowRun, runWorkflow } from "../src/runtime/client.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

beforeEach(() => {
  resetWorkflowRuntime()
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockUpstash() {
  const store = new Map<string, string>()
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body || "[]")) as string[]
    const [operation, key, value] = command
    if (operation === "SET") {
      store.set(key, value)
      return Response.json({ result: "OK" })
    }
    if (operation === "GET") {
      return Response.json({ result: store.get(key) || null })
    }
    return Response.json({ result: null })
  })
  vi.stubGlobal("fetch", fetch)
  process.env.KV_REST_API_URL = "https://example.upstash.io"
  process.env.KV_REST_API_TOKEN = "token"
  return { fetch, store }
}

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

  it("reads persisted Vercel run state when local memory misses", async () => {
    mockUpstash()
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

    await runWorkflow("welcome", {}, { id: "persisted" })
    resetWorkflowRuntime()
    setWorkflowRuntimeConfig({ provider: "vercel" })

    await expect(getWorkflowRun("welcome", "persisted")).resolves.toMatchObject({ status: "running" })
    resolveRun?.({ ok: true })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("welcome", "persisted")).resolves.toMatchObject({
        result: { ok: true },
        status: "completed",
      })
    })
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

  it("validates Cloudflare workflow names before binding dispatch", async () => {
    const create = vi.fn()
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CUSTOM", provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            env: {
              WORKFLOW_CUSTOM: { create, get: vi.fn() },
            },
          },
        },
      },
    })

    await expect(runWorkflow("welcom", {}, { id: "typo" })).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
    })
    expect(create).not.toHaveBeenCalled()
  })

  it("returns unknown when persisted Vercel run state is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("upstash unavailable")
    }))
    process.env.KV_REST_API_URL = "https://example.upstash.io"
    process.env.KV_REST_API_TOKEN = "token"
    setWorkflowRuntimeConfig({ provider: "vercel" })

    await expect(getWorkflowRun("welcome", "missing")).resolves.toMatchObject({
      provider: "vercel",
      status: "unknown",
    })
  })

  it("records synchronous workflow handler failures", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: () => {
            throw new Error("invalid payload")
          },
        },
      }),
    })

    const run = await runWorkflow("welcome", {}, { id: "sync-failure" })
    expect(run).toMatchObject({ status: "queued" })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("welcome", "sync-failure")).resolves.toMatchObject({
        status: "failed",
      })
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

  it("treats terminated Cloudflare workflow runs as failed", async () => {
    const get = vi.fn(async (id: string) => ({
      id,
      status: vi.fn(async () => ({ status: "terminated" })),
    }))

    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    enterWorkflowRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            env: {
              [getCloudflareWorkflowBindingName("welcome")]: { create: vi.fn(), get },
            },
          },
        },
      },
    })

    await expect(getWorkflowRun("welcome", "terminated-1")).resolves.toMatchObject({
      provider: "cloudflare",
      status: "failed",
    })
  })
})
