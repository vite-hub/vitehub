import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkflowProviderStep } from "../src/types.ts"
import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { createWorkflow, deferWorkflow, getWorkflowRun, runWorkflow } from "../src/runtime/client.ts"
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
  it("defines inline workflows and returns a typed runtime handle", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })

    const workflow = createWorkflow<{ message: string }, { reply: string }>("inline-reply", async ({ payload }) => ({
      reply: payload.message.toUpperCase(),
    }))

    expect(workflow.name).toBe("inline-reply")
    const run = await workflow.run({ message: "hello" }, { id: "inline-1" })
    expect(run).toMatchObject({ provider: "vercel", status: "queued" })

    await vi.waitFor(async () => {
      await expect(workflow.getRun("inline-1")).resolves.toMatchObject({
        result: { reply: "HELLO" },
        status: "completed",
      })
    })
  })

  it("returns handles for discovered workflows without redefining them", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async ({ payload }) => ({ payload }) },
      }),
    })

    const workflow = createWorkflow<{ message: string }, { payload: { message: string } }>("welcome")
    const run = await workflow.defer({ message: "hello" }, { id: "welcome-handle" })

    await vi.waitFor(async () => {
      await expect(workflow.getRun(run.id)).resolves.toMatchObject({
        result: { payload: { message: "hello" } },
        status: "completed",
      })
    })
  })

  it("derives stable run ids from workflow handle options", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })

    const workflow = createWorkflow<
      { messageId: string, placeholderMessageId: string, threadId: string },
      { ok: boolean }
    >("chat-reply", async () => ({ ok: true }), {
      id: ({ payload }) => ({
        messageId: payload?.messageId,
        threadId: payload?.threadId,
      }),
    })

    const first = await workflow.run({ messageId: "m1", placeholderMessageId: "p1", threadId: "t1" })
    const second = await workflow.run({ messageId: "m1", placeholderMessageId: "p2", threadId: "t1" })

    expect(first.id).toBe(second.id)
    expect(first.id).toMatch(/^chat-reply-[a-f0-9]{32}$/)
  })

  it("lets explicit run ids override workflow handle id resolvers", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })

    const workflow = createWorkflow("stable-id", async () => "ok", {
      id: () => "derived",
    })

    await expect(workflow.run({}, { id: "manual" })).resolves.toMatchObject({
      id: "manual",
    })
  })

  it("supports id resolvers on discovered workflow handles", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async ({ payload }) => ({ payload }) },
      }),
    })

    const workflow = createWorkflow<{ accountId: string }, { payload: { accountId: string } }>("welcome", {
      id: ({ payload }) => ({ accountId: payload?.accountId }),
    })
    const run = await workflow.defer({ accountId: "acct_1" })

    expect(run.id).toMatch(/^welcome-[a-f0-9]{32}$/)
  })

  it("rejects duplicate inline workflow definitions", () => {
    createWorkflow("duplicate", async () => "one")
    expect(() => createWorkflow("duplicate", async () => "two")).toThrow(/Duplicate workflow name "duplicate"/)
  })

  it("rejects inline and discovered workflow duplicates", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      duplicate: async () => ({ default: { handler: async () => "discovered" } }),
    })
    createWorkflow("duplicate", async () => "inline")

    await expect(runWorkflow("duplicate", {})).rejects.toThrow(/Duplicate workflow name "duplicate"/)
  })

  it("wraps Cloudflare workflow handlers with provider steps", async () => {
    const stepDo = vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run())
    const step = { do: stepDo } as WorkflowProviderStep

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      env: {},
      event: { id: "run-1", payload: { message: "hello" } },
      name: "welcome",
      registry: {
        welcome: async () => ({ default: { handler: async ({ payload }) => ({ payload }) } }),
      },
      step,
    })).resolves.toEqual({ payload: { message: "hello" } })

    expect(stepDo).toHaveBeenCalledWith(
      "welcome",
      { retries: { backoff: "exponential", delay: "10 seconds", limit: 3 } },
      expect.any(Function),
    )
  })

  it("does not wrap generated folder workflows in a root provider step", async () => {
    const stepDo = vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run())
    const step = { do: stepDo } as WorkflowProviderStep

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      env: {},
      event: { id: "run-1", payload: "start" },
      name: "pipeline",
      registry: {
        pipeline: async () => ({
          default: {
            options: { rootStep: false },
            handler: async ({ step }) => {
              await step?.do?.("pipeline/01.first", {}, async () => "first")
              await step?.do?.("pipeline/02.second", {}, async () => "second")
              return "done"
            },
          },
        }),
      },
      step,
    })).resolves.toBe("done")

    expect(stepDo).toHaveBeenCalledTimes(2)
    expect(stepDo.mock.calls.map(call => call[0])).toEqual(["pipeline/01.first", "pipeline/02.second"])
  })

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
