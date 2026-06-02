import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkflowProviderStep } from "../src/types.ts"
import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { resetOpenWorkflowRuntime, setOpenWorkflowImporter } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { createWorkflow, deferWorkflow, getWorkflowRun, runWorkflow } from "../src/runtime/client.ts"
import { createWorkflowSteps } from "../src/runtime/execute.ts"
import { enterWorkflowRuntimeEvent, getInlineWorkflowDefinitions, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, takeInlineWorkflowDefinition } from "../src/runtime/state.ts"

const openWorkflowMock = vi.hoisted(() => {
  const runs = new Map<string, any>()
  const definitions = new Map<string, any>()
  const connect = vi.fn(async (_url: string, _options?: unknown) => ({
    getWorkflowRun: vi.fn(async ({ workflowRunId }: { workflowRunId: string }) => runs.get(workflowRunId) || null),
    stop: vi.fn(),
  }))
  const newWorker = vi.fn((options?: unknown) => ({
    options,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }))
  const runOptions: unknown[] = []

  class OpenWorkflow {
    constructor(public readonly options: unknown) {}

    defineWorkflow(spec: { name: string }, fn: (context: any) => unknown) {
      definitions.set(spec.name, fn)
      return {
        run: vi.fn(async (input: unknown, options?: { idempotencyKey?: string }) => {
          runOptions.push(options)
          const id = `ow-${runs.size + 1}`
          const run: any = {
            attempts: 0,
            availableAt: null,
            config: null,
            context: null,
            createdAt: new Date(),
            deadlineAt: null,
            error: null as unknown,
            finishedAt: null,
            id,
            idempotencyKey: options?.idempotencyKey || null,
            input,
            namespaceId: "production",
            output: null as unknown,
            parentStepAttemptId: null,
            parentStepAttemptNamespaceId: null,
            startedAt: null,
            status: "pending",
            updatedAt: new Date(),
            version: null,
            workerId: null,
            workflowName: spec.name,
          }
          runs.set(id, run)
          setTimeout(async () => {
            try {
              run.status = "completed"
              run.output = await fn({
                input,
                run: { createdAt: run.createdAt, id, startedAt: run.startedAt, workflowName: spec.name },
                step: {
                  run: async (_config: unknown, stepRun: () => unknown) => await stepRun(),
                },
                version: null,
              })
            }
            catch (error) {
              run.error = error
              run.status = "failed"
            }
          }, 0)
          return {
            result: async () => run.output,
            workflowRun: run,
          }
        }),
        workflow: { fn, spec },
      }
    }

    newWorker(options?: unknown) {
      return newWorker(options)
    }
  }

  return {
    connect,
    definitions,
    newWorker,
    OpenWorkflow,
    runOptions,
    runs,
  }
})

vi.mock("openworkflow", () => ({
  OpenWorkflow: openWorkflowMock.OpenWorkflow,
}))

vi.mock("openworkflow/postgres", () => ({
  BackendPostgres: {
    connect: openWorkflowMock.connect,
  },
}))

beforeEach(async () => {
  resetWorkflowRuntime()
  await resetOpenWorkflowRuntime()
  setOpenWorkflowImporter(async (specifier) => {
    if (specifier === "openworkflow") {
      return { OpenWorkflow: openWorkflowMock.OpenWorkflow } as never
    }
    if (specifier === "openworkflow/postgres") {
      return { BackendPostgres: { connect: openWorkflowMock.connect } } as never
    }
    return await import(specifier) as never
  })
  openWorkflowMock.connect.mockClear()
  openWorkflowMock.definitions.clear()
  openWorkflowMock.newWorker.mockClear()
  openWorkflowMock.runOptions.length = 0
  openWorkflowMock.runs.clear()
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  delete process.env.OPENWORKFLOW_NAMESPACE_ID
  delete process.env.OPENWORKFLOW_POSTGRES_URL
  delete process.env.OPENWORKFLOW_SCHEMA
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

  it("registers object-form handlers for named workflows", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })

    const workflow = createWorkflow<{ message: string }, { reply: string }>("object-inline-reply", {
      handler: async ({ payload }) => ({
        reply: payload.message.toUpperCase(),
      }),
      id: ({ payload }) => payload?.message || "missing",
    })
    const run = await workflow.run({ message: "hello" })

    expect(run).toMatchObject({ provider: "vercel", status: "queued" })
    expect(run.id).toMatch(/^object-inline-reply-/)
    await vi.waitFor(async () => {
      await expect(workflow.getRun(run.id)).resolves.toMatchObject({
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

  it("prefers inline definitions registered while loading discovered entries", async () => {
    const discovered = vi.fn(async () => "discovered")
    const inline = vi.fn(async () => "inline")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      mixed: async () => {
        createWorkflow("mixed", inline)
        return { default: { handler: discovered } }
      },
    })

    const firstRun = await runWorkflow("mixed", undefined, { id: "first" })
    const secondRun = await runWorkflow("mixed", undefined, { id: "second" })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("mixed", firstRun.id)).resolves.toMatchObject({ result: "inline" })
      await expect(getWorkflowRun("mixed", secondRun.id)).resolves.toMatchObject({ result: "inline" })
    })
    expect(inline).toHaveBeenCalledTimes(2)
    expect(discovered).not.toHaveBeenCalled()
  })

  it("uses a single inline definition registered by a discovered location entry", async () => {
    const inline = vi.fn(async () => "inline")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      "server/workflows/chat": async () => {
        const chat = createWorkflow("legacy-chat-name", inline)
        return { chat }
      },
    })

    const run = await runWorkflow("server/workflows/chat", undefined, { id: "chat" })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("server/workflows/chat", run.id)).resolves.toMatchObject({ result: "inline" })
    })
    expect(inline).toHaveBeenCalledTimes(1)
  })

  it("prefers default exported inline handles when modules export helpers too", async () => {
    const inline = vi.fn(async () => "inline")
    const helper = vi.fn(async () => "helper")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      "server/workflows/chat": async () => {
        const chat = createWorkflow("legacy-chat-name", inline)
        const helperWorkflow = createWorkflow("helper", helper)
        return { default: chat, helperWorkflow } as never
      },
    })

    const run = await runWorkflow("server/workflows/chat", undefined, { id: "chat" })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("server/workflows/chat", run.id)).resolves.toMatchObject({ result: "inline" })
    })
    expect(inline).toHaveBeenCalledTimes(1)
    expect(helper).not.toHaveBeenCalled()
  })

  it("consumes inline fallback definitions after binding them to discovered entries", async () => {
    const first = vi.fn(async () => "first")
    const second = vi.fn(async () => "second")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      first: async () => {
        const workflow = createWorkflow("legacy-name", first)
        return { workflow }
      },
      second: async () => {
        const workflow = createWorkflow("legacy-name", second)
        return { workflow }
      },
    })

    const firstRun = await runWorkflow("first", undefined, { id: "first" })
    const secondRun = await runWorkflow("second", undefined, { id: "second" })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("first", firstRun.id)).resolves.toMatchObject({ result: "first" })
      await expect(getWorkflowRun("second", secondRun.id)).resolves.toMatchObject({ result: "second" })
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(getInlineWorkflowDefinitions().has("legacy-name")).toBe(false)
  })

  it("does not resolve discovered workflows to unexported helper handles", async () => {
    const helper = vi.fn(async () => "helper")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      "server/workflows/chat": async () => {
        createWorkflow("helper", helper)
        return {}
      },
    })

    await expect(runWorkflow("server/workflows/chat", undefined, { id: "chat" })).rejects.toThrow(/Unknown workflow definition/)
    expect(helper).not.toHaveBeenCalled()
  })

  it("does not resolve non-object module loads to unexported inline handles", async () => {
    const helper = vi.fn(async () => "helper")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      "server/workflows/chat": async () => {
        createWorkflow("helper", helper)
        return undefined as never
      },
    })

    await expect(runWorkflow("server/workflows/chat", undefined, { id: "chat" })).rejects.toThrow(/Unknown workflow definition/)
    expect(helper).not.toHaveBeenCalled()
  })

  it("prefers discovered default exports over helper inline handles", async () => {
    const discovered = vi.fn(async () => "discovered")
    const helper = vi.fn(async () => "helper")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      mixed: async () => {
        createWorkflow("helper", helper)
        return { default: { handler: discovered } }
      },
    })

    const run = await runWorkflow("mixed", undefined, { id: "mixed" })

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("mixed", run.id)).resolves.toMatchObject({ result: "discovered" })
    })
    expect(discovered).toHaveBeenCalledTimes(1)
    expect(helper).not.toHaveBeenCalled()
  })

  it("keeps inline fallbacks scoped to their own discovered entry load", async () => {
    const alpha = vi.fn(async () => "alpha")
    let releaseAlpha!: () => void
    const alphaReady = new Promise<void>(resolve => {
      releaseAlpha = resolve
    })

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      alpha: async () => {
        const workflow = createWorkflow("legacy-alpha", alpha)
        await alphaReady
        return { workflow }
      },
      beta: async () => ({}),
    })

    const alphaRun = runWorkflow("alpha", undefined, { id: "alpha" })
    await vi.waitFor(() => {
      expect(getInlineWorkflowDefinitions().has("legacy-alpha")).toBe(true)
    })
    await expect(runWorkflow("beta", undefined, { id: "beta" })).rejects.toThrow(/Unknown workflow definition: beta/)
    releaseAlpha()
    await alphaRun
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

  it("runs inline folder workflows through generated step wrappers", async () => {
    const stepDo = vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run())
    const step = { do: stepDo } as WorkflowProviderStep

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      env: {},
      event: { id: "run-1", payload: "start" },
      name: "pipeline",
      registry: {
        pipeline: async () => {
          createWorkflow("pipeline", async ({ payload, steps }) => await steps!.first(payload))
          const definition = takeInlineWorkflowDefinition("pipeline")!
          const steps = [{ name: "01.first.ts", run: async (input: unknown) => `${input}-step` }]
          return {
            ...definition,
            options: { ...definition.options, rootStep: false },
            handler: async context => await definition.handler({
              ...context,
              steps: createWorkflowSteps(context, steps),
            }),
          }
        },
      },
      step,
    })).resolves.toBe("start-step")

    expect(stepDo).toHaveBeenCalledTimes(1)
    expect(stepDo).toHaveBeenCalledWith(
      "pipeline/01.first.ts",
      { retries: { backoff: "exponential", delay: "10 seconds", limit: 3 } },
      expect.any(Function),
    )
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

  it("runs registered definitions through the OpenWorkflow provider", async () => {
    setWorkflowRuntimeConfig({
      postgres: {
        namespaceId: "production",
        runMigrations: false,
        schema: "openworkflow",
        url: "postgres://localhost/vitehub",
      },
      provider: "openworkflow",
    })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async ({ payload }) => ({ payload }) },
      }),
    })

    const run = await runWorkflow("welcome", { message: "hello" }, { id: "welcome-idempotency-key" })
    expect(run).toMatchObject({
      metadata: { idempotencyKey: "welcome-idempotency-key", workflow: "welcome" },
      provider: "openworkflow",
      status: "queued",
    })
    expect(openWorkflowMock.connect).toHaveBeenCalledWith("postgres://localhost/vitehub", {
      namespaceId: "production",
      runMigrations: false,
      schema: "openworkflow",
    })
    expect(openWorkflowMock.runOptions).toEqual([{ idempotencyKey: "welcome-idempotency-key" }])

    await vi.waitFor(async () => {
      await expect(getWorkflowRun("welcome", run.id)).resolves.toMatchObject({
        provider: "openworkflow",
        result: { payload: { message: "hello" } },
        status: "completed",
      })
    })
  })

  it("reads OpenWorkflow Postgres connection options from runtime environment", async () => {
    process.env.OPENWORKFLOW_NAMESPACE_ID = "staging"
    process.env.OPENWORKFLOW_POSTGRES_URL = "postgres://localhost/env"
    process.env.OPENWORKFLOW_SCHEMA = "workflow_schema"
    setWorkflowRuntimeConfig({ provider: "openworkflow" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await runWorkflow("welcome", {})

    expect(openWorkflowMock.connect).toHaveBeenCalledWith("postgres://localhost/env", {
      namespaceId: "staging",
      schema: "workflow_schema",
    })
  })

  it("requires a Postgres URL for the OpenWorkflow provider", async () => {
    setWorkflowRuntimeConfig({ provider: "openworkflow" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expect(runWorkflow("welcome", {})).rejects.toThrow(/Missing OpenWorkflow Postgres URL/)
  })

  it("creates an OpenWorkflow worker from the runtime registry", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
      worker: { concurrency: 3 },
    })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    const worker = await createOpenWorkflowWorker()

    expect(openWorkflowMock.definitions.has("welcome")).toBe(true)
    expect(openWorkflowMock.newWorker).toHaveBeenCalledWith({ concurrency: 3 })
    await worker.start()
    expect(worker.start).toHaveBeenCalled()
  })

  it("registers inline workflow definitions in OpenWorkflow workers", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    createWorkflow("inline-worker", async () => ({ ok: true }))

    await createOpenWorkflowWorker()

    expect(openWorkflowMock.definitions.has("inline-worker")).toBe(true)
  })

  it("registers exported inline handles under discovered names in OpenWorkflow workers", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    setWorkflowRuntimeRegistry({
      "server/workflows/chat": async () => {
        const workflow = createWorkflow("legacy-chat-name", async () => ({ ok: true }))
        return { workflow }
      },
    })

    await createOpenWorkflowWorker()

    expect(openWorkflowMock.definitions.has("server/workflows/chat")).toBe(true)
    expect(openWorkflowMock.definitions.has("legacy-chat-name")).toBe(false)
  })

  it("registers wrapped inline folder workflows in OpenWorkflow workers", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    setWorkflowRuntimeRegistry({
      pipeline: async () => {
        createWorkflow("pipeline", async ({ payload, steps }) => await steps!.first(payload))
        const definition = takeInlineWorkflowDefinition("pipeline")!
        const steps = [{ name: "01.first.ts", run: async (input: unknown) => `${input}-step` }]
        return {
          ...definition,
          options: { ...definition.options, rootStep: false },
          handler: async context => await definition.handler({
            ...context,
            steps: createWorkflowSteps(context, steps),
          }),
        }
      },
    })

    await createOpenWorkflowWorker()

    expect(openWorkflowMock.definitions.has("pipeline")).toBe(true)
  })

  it("rejects duplicate inline and discovered OpenWorkflow worker definitions", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    setWorkflowRuntimeRegistry({
      duplicate: async () => ({ default: { handler: async () => "discovered" } }),
    })
    createWorkflow("duplicate", async () => "inline")

    await expect(createOpenWorkflowWorker()).rejects.toThrow(/Duplicate workflow name "duplicate"/)
  })

  it("shares in-flight discovered workflow definition loads", async () => {
    let resolveDefinition: (() => void) | undefined
    const entry = vi.fn(async () => {
      await new Promise<void>(resolve => {
        resolveDefinition = resolve
      })
      return {
        default: { handler: async ({ payload }: { payload: unknown }) => ({ payload }) },
      }
    })

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({ welcome: entry })

    const firstRun = runWorkflow("welcome", { message: "first" }, { id: "first" })
    const secondRun = runWorkflow("welcome", { message: "second" }, { id: "second" })

    await vi.waitFor(() => {
      expect(resolveDefinition).toBeDefined()
    })
    resolveDefinition?.()

    await expect(firstRun).resolves.toMatchObject({ id: "first", status: "queued" })
    await expect(secondRun).resolves.toMatchObject({ id: "second", status: "queued" })
    expect(entry).toHaveBeenCalledTimes(1)
  })

  it("throws for missing definitions", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({})

    await expect(runWorkflow("missing", {})).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
    })
  })

  it("does not recurse when an inline registry entry registers no definition", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      missing: async () => await runWorkflow("missing", {}),
    } as never)

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

  it("uses request waitUntil for deferred Cloudflare workflow dispatch", async () => {
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
