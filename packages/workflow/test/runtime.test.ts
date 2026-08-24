import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runInNewContext } from "node:vm"

import { getActiveCloudflareEnv, runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { ViteHubError } from "@vite-hub/runtime"
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import type { WorkflowProviderStep } from "../src/types.ts"
import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { getOpenWorkflowRuntime, resetOpenWorkflowRuntime, setOpenWorkflowImporter } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker, startOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"
import { createWorkflowCloudflareWorker } from "../src/runtime/cloudflare-vite.ts"
import { cancelWorkflow, createWorkflow, deferWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow } from "../src/runtime/client.ts"
import { createWorkflowSteps } from "../src/runtime/execute.ts"
import { enterWorkflowRuntimeEvent, getInlineWorkflowDefinitions, getWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, takeInlineWorkflowDefinition } from "../src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader } from "../src/runtime/vercel.ts"

import type { VercelRun, VercelStep, VercelWorkflowRuntime } from "../src/runtime/vercel.ts"

const openWorkflowMock = vi.hoisted(() => {
  const runs = new Map<string, any>()
  const definitions = new Map<string, any>()
  const connect = vi.fn(async (_url: string, _options?: unknown) => ({
    getWorkflowRun: vi.fn(async ({ workflowRunId }: { workflowRunId: string }) => runs.get(workflowRunId) || null),
    stop: vi.fn(),
  }))
  const sqliteConnect = vi.fn((_path: string, _options?: unknown) => ({
    getWorkflowRun: vi.fn(async ({ workflowRunId }: { workflowRunId: string }) => runs.get(workflowRunId) || null),
    stop: vi.fn(),
  }))
  const newWorker = vi.fn((options?: unknown) => ({
    options,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }))
  const runOptions: unknown[] = []
  const sleepCalls: unknown[][] = []

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
            // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
            error: null as unknown,
            finishedAt: null,
            id,
            idempotencyKey: options?.idempotencyKey || null,
            input,
            namespaceId: "production",
            // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
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
                  sleep: async (...args: unknown[]) => { sleepCalls.push(args) },
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
    sleepCalls,
    sqliteConnect,
  }
})

it("types handler-owned results and unknown named Workflow results honestly", () => {
  const inline = createWorkflow<{ message: string }, { reply: string }>("typed-inline", async ({ payload }) => ({ reply: payload.message }))
  const discovered = createWorkflow<{ message: string }>("typed-discovered")

  expectTypeOf<Awaited<ReturnType<typeof inline.run>>["result"]>().toEqualTypeOf<{ reply: string } | undefined>()
  expectTypeOf<Awaited<ReturnType<typeof inline.getRun>>["result"]>().toEqualTypeOf<unknown>()
  expectTypeOf<Awaited<ReturnType<typeof discovered.run>>["result"]>().toEqualTypeOf<unknown>()
  expectTypeOf<Awaited<ReturnType<typeof discovered.getRun>>["result"]>().toEqualTypeOf<unknown>()
  expectTypeOf<Awaited<ReturnType<typeof runWorkflow<{ message: string }>>>["result"]>().toEqualTypeOf<unknown>()
  expectTypeOf<Awaited<ReturnType<typeof getWorkflowRun>>["result"]>().toEqualTypeOf<unknown>()
  expectTypeOf<Awaited<ReturnType<typeof cancelWorkflow>>["result"]>().toEqualTypeOf<unknown>()
})

type OpenWorkflowMockBackend = Awaited<ReturnType<typeof openWorkflowMock.connect>>

vi.mock("openworkflow", () => ({
  OpenWorkflow: openWorkflowMock.OpenWorkflow,
}))

vi.mock("openworkflow/postgres", () => ({
  BackendPostgres: {
    connect: openWorkflowMock.connect,
  },
}))

vi.mock("openworkflow/sqlite", () => ({
  BackendSqlite: {
    connect: openWorkflowMock.sqliteConnect,
  },
}))

function setOpenWorkflowMockImporter(): void {
  setOpenWorkflowImporter(async (specifier) => {
    if (specifier === "openworkflow") {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return { OpenWorkflow: openWorkflowMock.OpenWorkflow } as never
    }
    if (specifier === "openworkflow/postgres") {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return { BackendPostgres: { connect: openWorkflowMock.connect } } as never
    }
    if (specifier === "openworkflow/sqlite") {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
    }
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    return await import(specifier) as never
  })
}

function interceptProcessSignals(): {
  listeners: Map<string, () => void>
  off: ReturnType<typeof vi.spyOn>
  on: ReturnType<typeof vi.spyOn>
} {
  const listeners = new Map<string, () => void>()
  // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
  const on = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
    listeners.set(event, listener)
    return process
  }) as typeof process.on)
  // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
  const off = vi.spyOn(process, "off").mockImplementation(((event: string, listener: () => void) => {
    if (listeners.get(event) === listener) listeners.delete(event)
    return process
  }) as typeof process.off)
  return { listeners, off, on }
}

beforeEach(async () => {
  resetWorkflowRuntime()
  await resetOpenWorkflowRuntime()
  setOpenWorkflowMockImporter()
  openWorkflowMock.connect.mockClear()
  openWorkflowMock.sqliteConnect.mockClear()
  openWorkflowMock.definitions.clear()
  openWorkflowMock.newWorker.mockClear()
  openWorkflowMock.runOptions.length = 0
  openWorkflowMock.runs.clear()
  openWorkflowMock.sleepCalls.length = 0
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  delete process.env.OPENWORKFLOW_NAMESPACE_ID
  delete process.env.OPENWORKFLOW_POSTGRES_URL
  delete process.env.OPENWORKFLOW_SCHEMA
  delete process.env.OPENWORKFLOW_SQLITE_PATH
  delete process.env.VITEHUB_WORKFLOW_DATABASE_URL
})

afterEach(() => {
  setVercelWorkflowRuntimeLoader()
  vi.restoreAllMocks()
})

describe("workflow runtime", () => {
  async function expectProviderFailure(
    request: Promise<unknown>,
    cause: unknown,
    details: { acknowledgement?: "unknown", operation: string, provider: string, status?: number },
  ) {
    const error = await request.catch(error => error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      cause,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details,
      message: "Workflow provider operation failed.",
    })
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details,
      message: "Workflow provider operation failed.",
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain("provider-secret")
  }

  async function expectInvalidProviderResult(
    request: Promise<unknown>,
    operation: string,
    field: string,
  ) {
    const error = await request.catch(error => error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      cause: new TypeError(`Vercel Workflow provider returned an invalid ${field}.`),
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation, provider: "vercel" },
      message: "Workflow provider operation failed.",
    })
  }

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
        default: { handler: async ({ payload, step }) => {
          await step?.sleep?.("settle", "1 second")
          return { payload }
        } },
      }),
    })

    const workflow = createWorkflow<{ message: string }>("welcome")
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

    const workflow = createWorkflow<{ accountId: string }>("welcome", {
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
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
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

    await expect(runWorkflow("server/workflows/chat", undefined, { id: "chat" })).rejects.toThrow("Workflow definition was not found.")
    expect(helper).not.toHaveBeenCalled()
  })

  it("does not resolve non-object module loads to unexported inline handles", async () => {
    const helper = vi.fn(async () => "helper")

    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      "server/workflows/chat": async () => {
        createWorkflow("helper", helper)
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return undefined as never
      },
    })

    await expect(runWorkflow("server/workflows/chat", undefined, { id: "chat" })).rejects.toThrow("Workflow definition was not found.")
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
    await expect(runWorkflow("beta", undefined, { id: "beta" })).rejects.toThrow("Workflow definition was not found.")
    releaseAlpha()
    await alphaRun
  })

  it("wraps Cloudflare workflow handlers with provider steps", async () => {
    const stepDo = vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run())
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
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

  it("restores Cloudflare runtime context inside provider step callbacks", async () => {
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const step = {
      do: vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await runWithActiveCloudflareEnv(undefined, run)),
    } as WorkflowProviderStep

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      env: { REQUEST_ID: "step" },
      event: { id: "run-1" },
      name: "welcome",
      registry: {
        welcome: async () => ({
          default: {
            handler: async () => ({
              active: getActiveCloudflareEnv()?.REQUEST_ID,
              // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
              event: (getWorkflowRuntimeEvent() as { env?: { REQUEST_ID?: string } } | undefined)?.env?.REQUEST_ID,
            }),
          },
        }),
      },
      step,
    })).resolves.toEqual({ active: "step", event: "step" })
  })

  it("converts explicitly non-retryable Cloudflare workflow errors", async () => {
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const original = Object.assign(new Error("invalid input"), { isRetryable: false as const })
    const converted = new Error("non-retryable: invalid input")
    const createNonRetryableError = vi.fn(() => converted)
    const stepSleep = vi.fn(async () => {})
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const step = {
      do: vi.fn(async (_name: string, _options: unknown, run: () => unknown) => {
        try {
          return await run()
        }
        catch (error) {
          expect(error).toBe(converted)
          throw error
        }
      }),
      sleep: stepSleep,
    } as WorkflowProviderStep

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      createNonRetryableError,
      env: {},
      event: { id: "run-1" },
      name: "welcome",
      registry: {
        welcome: async () => ({ default: { handler: async ({ step }) => {
          await step?.sleep?.("settle", "1 second")
          throw original
        } } }),
      },
      step,
    })).rejects.toBe(converted)

    expect(createNonRetryableError).toHaveBeenCalledWith(original)
    expect(step.do).toHaveBeenCalledOnce()
    expect(stepSleep).toHaveBeenCalledWith("settle", "1 second")
  })

  it("isolates overlapping Cloudflare fetch environments", async () => {
    let arrivals = 0
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => {
      release = resolve
    })
    const worker = createWorkflowCloudflareWorker({
      app: async () => {
        const before = getActiveCloudflareEnv()?.REQUEST_ID
        arrivals += 1
        if (arrivals === 2) release()
        await bothStarted
        return Response.json({ after: getActiveCloudflareEnv()?.REQUEST_ID, before })
      },
    })

    const [first, second] = await Promise.all([
      worker.fetch(new Request("https://example.com/first"), { REQUEST_ID: "first" }, { waitUntil: vi.fn() }),
      worker.fetch(new Request("https://example.com/second"), { REQUEST_ID: "second" }, { waitUntil: vi.fn() }),
    ])

    await expect(first.json()).resolves.toEqual({ after: "first", before: "first" })
    await expect(second.json()).resolves.toEqual({ after: "second", before: "second" })
  })

  it("isolates overlapping Cloudflare runner environments", async () => {
    let arrivals = 0
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => {
      release = resolve
    })
    const registry = {
      welcome: async () => ({
        default: {
          handler: async ({ payload }: { payload: unknown }) => {
            const before = getActiveCloudflareEnv()?.REQUEST_ID
            arrivals += 1
            if (arrivals === 2) release()
            await bothStarted
            return { after: getActiveCloudflareEnv()?.REQUEST_ID, before, payload }
          },
        },
      }),
    }

    const [first, second] = await Promise.all([
      runCloudflareWorkflow({ config: { provider: "cloudflare" }, env: { REQUEST_ID: "first" }, event: { id: "first", payload: "first" }, name: "welcome", registry }),
      runCloudflareWorkflow({ config: { provider: "cloudflare" }, env: { REQUEST_ID: "second" }, event: { id: "second", payload: "second" }, name: "welcome", registry }),
    ])

    expect(first).toEqual({ after: "first", before: "first", payload: "first" })
    expect(second).toEqual({ after: "second", before: "second", payload: "second" })
  })

  it("does not wrap generated folder workflows in a root provider step", async () => {
    const stepDo = vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run())
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
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

  it("does not replay a root handler after a completed write", async () => {
    const transient = Object.assign(new Error("provider unavailable"), {
      name: "AI_APICallError",
      statusCode: 503,
    })
    let writes = 0
    const stepDo = vi.fn(async (_name: string, _options: unknown, run: () => Promise<unknown>) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await run()
        }
        catch (error) {
          if (attempt === 3) throw error
        }
      }
    })

    await expect(runCloudflareWorkflow({
      config: { provider: "cloudflare" },
      env: {},
      event: { id: "run-after-write" },
      name: "agent",
      registry: {
        agent: async () => {
          createWorkflow("agent", async () => {
            writes += 1
            throw transient
          }, { rootStep: false })
          return { default: takeInlineWorkflowDefinition("agent")! }
        },
      },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      step: { do: stepDo } as WorkflowProviderStep,
    })).rejects.toBe(transient)

    expect(writes).toBe(1)
    expect(stepDo).not.toHaveBeenCalled()
  })

  it("runs inline folder workflows through generated step wrappers", async () => {
    const stepDo = vi.fn(async (_name: string, _options: unknown, run: () => unknown) => await run())
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
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
        default: { handler: async ({ payload, step }) => {
          await step?.sleep?.("settle", "1 second")
          return { payload }
        } },
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
        default: { handler: async ({ payload, step }) => {
          await step?.sleep?.("settle", "1 second")
          return { payload }
        } },
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
    expect(openWorkflowMock.sleepCalls).toEqual([["settle", "1 second"]])
  })

  it("shares one OpenWorkflow acquisition and closes its backend once", async () => {
    let resolveBackend: ((backend: OpenWorkflowMockBackend) => void) | undefined
    const stop = vi.fn()
    const backend = { getWorkflowRun: vi.fn(), stop }
    openWorkflowMock.connect.mockImplementationOnce(() => new Promise((resolve) => {
      resolveBackend = resolve
    }))
    const config = {
      postgres: { url: "postgres://localhost/shared" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      provider: "openworkflow" as const,
    }

    const first = getOpenWorkflowRuntime(config)
    const second = getOpenWorkflowRuntime(config)
    await vi.waitFor(() => expect(openWorkflowMock.connect).toHaveBeenCalledOnce())
    resolveBackend?.(backend)

    await expect(first).resolves.toBe(await second)
    await resetOpenWorkflowRuntime()
    await resetOpenWorkflowRuntime()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("evicts a rejected OpenWorkflow acquisition", async () => {
    const failure = new Error("database unavailable")
    const config = {
      postgres: { url: "postgres://localhost/retry" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      provider: "openworkflow" as const,
    }
    openWorkflowMock.connect.mockRejectedValueOnce(failure)

    await expect(getOpenWorkflowRuntime(config)).rejects.toMatchObject({
      cause: failure,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "connect", provider: "openworkflow" },
    })
    await expect(getOpenWorkflowRuntime(config)).resolves.toBeDefined()
    expect(openWorkflowMock.connect).toHaveBeenCalledTimes(2)
  })

  it("preserves every OpenWorkflow cleanup failure in cache order", async () => {
    const firstCause = new Error("first close failed")
    const secondCause = new Error("second close failed")
    const firstStop = vi.fn().mockRejectedValue(firstCause)
    const secondStop = vi.fn().mockRejectedValue(secondCause)
    const thirdStop = vi.fn()
    openWorkflowMock.connect
      .mockResolvedValueOnce({ getWorkflowRun: vi.fn(), stop: firstStop })
      .mockResolvedValueOnce({ getWorkflowRun: vi.fn(), stop: secondStop })
      .mockResolvedValueOnce({ getWorkflowRun: vi.fn(), stop: thirdStop })

    await Promise.all(["first", "second", "third"].map(url => getOpenWorkflowRuntime({
      postgres: { url: `postgres://localhost/${url}` },
      provider: "openworkflow",
    })))

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const failure = await resetOpenWorkflowRuntime().catch(error => error) as AggregateError
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe("OpenWorkflow backend cleanup failed for multiple runtimes.")
    expect(failure.errors).toEqual([
      expect.objectContaining({ cause: firstCause, code: "OPENWORKFLOW_BACKEND_CLOSE_FAILED" }),
      expect.objectContaining({ cause: secondCause, code: "OPENWORKFLOW_BACKEND_CLOSE_FAILED" }),
    ])
    expect(failure.errors.every(error => error instanceof ViteHubError)).toBe(true)
    expect(firstStop).toHaveBeenCalledOnce()
    expect(secondStop).toHaveBeenCalledOnce()
    expect(thirdStop).toHaveBeenCalledOnce()

    await expect(resetOpenWorkflowRuntime()).resolves.toBeUndefined()
    expect(firstStop).toHaveBeenCalledOnce()
    expect(secondStop).toHaveBeenCalledOnce()
    expect(thirdStop).toHaveBeenCalledOnce()

    const singleCause = new Error("single close failed")
    const singleStop = vi.fn().mockRejectedValue(singleCause)
    setOpenWorkflowMockImporter()
    openWorkflowMock.connect.mockResolvedValueOnce({ getWorkflowRun: vi.fn(), stop: singleStop })
    await getOpenWorkflowRuntime({
      postgres: { url: "postgres://localhost/single" },
      provider: "openworkflow",
    })

    const singleFailure = await resetOpenWorkflowRuntime().catch(error => error)
    expect(singleFailure).toBeInstanceOf(ViteHubError)
    expect(singleFailure).toMatchObject({
      cause: singleCause,
      code: "OPENWORKFLOW_BACKEND_CLOSE_FAILED",
      details: { provider: "openworkflow" },
    })
    expect(singleStop).toHaveBeenCalledOnce()
  })

  it("separates OpenWorkflow acquisitions started across a reset", async () => {
    let resolveOldBackend: ((backend: OpenWorkflowMockBackend) => void) | undefined
    const oldStop = vi.fn()
    const newStop = vi.fn()
    openWorkflowMock.connect
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldBackend = resolve
      }))
      .mockResolvedValueOnce({ getWorkflowRun: vi.fn(), stop: newStop })
    const config = {
      postgres: { url: "postgres://localhost/reset-race" },
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      provider: "openworkflow" as const,
    }

    const oldRuntime = getOpenWorkflowRuntime(config)
    await vi.waitFor(() => expect(openWorkflowMock.connect).toHaveBeenCalledOnce())
    const resetting = resetOpenWorkflowRuntime()
    setOpenWorkflowMockImporter()
    const newRuntime = getOpenWorkflowRuntime(config)
    await vi.waitFor(() => expect(openWorkflowMock.connect).toHaveBeenCalledTimes(2))
    resolveOldBackend?.({ getWorkflowRun: vi.fn(), stop: oldStop })

    await expect(oldRuntime).rejects.toMatchObject({
      code: "OPENWORKFLOW_RUNTIME_RESET",
      details: { provider: "openworkflow" },
    })
    await expect(resetting).resolves.toBeUndefined()
    await expect(newRuntime).resolves.toBeDefined()
    expect(oldStop).toHaveBeenCalledOnce()
    expect(newStop).not.toHaveBeenCalled()

    await resetOpenWorkflowRuntime()
    expect(newStop).toHaveBeenCalledOnce()
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

  it("runs registered definitions through the OpenWorkflow SQLite provider", async () => {
    setWorkflowRuntimeConfig({
      provider: "openworkflow",
      sqlite: {
        namespaceId: "local",
        path: ".data/workflow.sqlite",
        runMigrations: false,
      },
    })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await runWorkflow("welcome", {})

    expect(openWorkflowMock.sqliteConnect).toHaveBeenCalledWith(".data/workflow.sqlite", {
      namespaceId: "local",
      runMigrations: false,
    })
    expect(openWorkflowMock.connect).not.toHaveBeenCalled()
  })

  it("creates parent directories for OpenWorkflow SQLite files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-sqlite-parent-"))
    const path = join(root, ".data/workflow/openworkflow.sqlite")
    expect(existsSync(dirname(path))).toBe(false)
    setWorkflowRuntimeConfig({
      provider: "openworkflow",
      sqlite: {
        path,
        runMigrations: false,
      },
    })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await runWorkflow("welcome", {})

    expect(existsSync(dirname(path))).toBe(true)
    expect(openWorkflowMock.sqliteConnect).toHaveBeenCalledWith(path, {
      namespaceId: "production",
      runMigrations: false,
    })
  })

  it("reads OpenWorkflow SQLite connection options from runtime environment", async () => {
    process.env.OPENWORKFLOW_NAMESPACE_ID = "local"
    process.env.OPENWORKFLOW_SQLITE_PATH = ".data/env-workflow.sqlite"
    setWorkflowRuntimeConfig({ provider: "openworkflow" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await runWorkflow("welcome", {})

    expect(openWorkflowMock.sqliteConnect).toHaveBeenCalledWith(".data/env-workflow.sqlite", {
      namespaceId: "local",
    })
  })

  it("resolves OpenWorkflow SQLite connection options from runtime config env declarations", async () => {
    process.env.VITEHUB_WORKFLOW_DATABASE_URL = "file:.data/runtime-workflow.sqlite"
    setWorkflowRuntimeConfig({
      provider: "openworkflow",
      sqlite: {
        path: {
          default: "file:.data/default-workflow.sqlite",
          kind: "env-variable",
          source: { kind: "env", name: "VITEHUB_WORKFLOW_DATABASE_URL" },
        },
      },
    })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await runWorkflow("welcome", {})

    expect(openWorkflowMock.sqliteConnect).toHaveBeenCalledWith(".data/runtime-workflow.sqlite", {
      namespaceId: "production",
    })
  })

  it("uses local SQLite storage for the OpenWorkflow provider by default", async () => {
    setWorkflowRuntimeConfig({ provider: "openworkflow" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await runWorkflow("welcome", {})

    expect(openWorkflowMock.sqliteConnect).toHaveBeenCalledWith(".vitehub/data/openworkflow.sqlite.db", {
      namespaceId: "production",
    })
  })

  it("narrows OpenWorkflow import failures at the public boundary", async () => {
    const cause = new Error("provider-secret:import")
    setOpenWorkflowImporter(async (specifier) => {
      if (specifier === "openworkflow") throw cause
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(runWorkflow("welcome", {}), cause, {
      operation: "import",
      provider: "openworkflow",
    })
  })

  it("narrows OpenWorkflow connection failures at the public boundary", async () => {
    const cause = new Error("provider-secret:connect")
    openWorkflowMock.sqliteConnect.mockImplementationOnce(() => { throw cause })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(runWorkflow("welcome", {}), cause, {
      operation: "connect",
      provider: "openworkflow",
    })
  })

  it("narrows OpenWorkflow client construction failures as connection failures", async () => {
    const cause = new Error("provider-secret:client")
    class RejectingOpenWorkflow {
      constructor() {
        throw cause
      }
    }
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: RejectingOpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(runWorkflow("welcome", {}), cause, {
      operation: "connect",
      provider: "openworkflow",
    })
  })

  it("narrows OpenWorkflow run failures at the public boundary", async () => {
    const cause = new Error("provider-secret:run")
    class RejectingOpenWorkflow {
      defineWorkflow() {
        return { run: async () => { throw cause } }
      }
    }
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: RejectingOpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(runWorkflow("welcome", {}), cause, {
      acknowledgement: "unknown",
      operation: "run",
      provider: "openworkflow",
    })
  })

  it("preserves definite OpenWorkflow run rejections", async () => {
    const cause = Object.assign(new Error("provider-secret:forbidden"), { status: 403 })
    class RejectingOpenWorkflow {
      defineWorkflow() {
        return { run: async () => { throw cause } }
      }
    }
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: RejectingOpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(runWorkflow("welcome", {}, { id: "source-run" }), cause, {
      operation: "run",
      provider: "openworkflow",
      status: 403,
    })
  })

  it("preserves a lost OpenWorkflow acknowledgement across a definite retry rejection", async () => {
    const first = new Error("creation acknowledgement lost")
    const retry = Object.assign(new Error("provider-secret:conflict"), { status: 409 })
    const run = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(retry)
    class RejectingOpenWorkflow {
      defineWorkflow() {
        return { run }
      }
    }
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: RejectingOpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(runWorkflow("welcome", {}, { id: "source-run" }), retry, {
      acknowledgement: "unknown",
      operation: "run",
      provider: "openworkflow",
      status: 409,
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("recovers OpenWorkflow runs after a lost creation acknowledgement", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("creation acknowledgement lost"))
      .mockResolvedValueOnce({ workflowRun: { id: "accepted-run", status: "pending" } })
    class RecoveringOpenWorkflow {
      defineWorkflow() {
        return { run }
      }
    }
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: RecoveringOpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expect(runWorkflow("welcome", {}, { id: "source-run" })).resolves.toMatchObject({
      id: "accepted-run",
      metadata: { idempotencyKey: "source-run" },
      provider: "openworkflow",
      status: "queued",
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(2, {}, { idempotencyKey: "source-run" })
  })

  it("narrows malformed OpenWorkflow run results at the public boundary", async () => {
    const cause = new Error("provider-secret:run-result")
    class MalformedOpenWorkflow {
      defineWorkflow() {
        return {
          run: async () => ({
            get workflowRun() {
              throw cause
            },
          }),
        }
      }
    }
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: MalformedOpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return { BackendSqlite: { connect: openWorkflowMock.sqliteConnect } } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(runWorkflow("welcome", {}), cause, {
      operation: "run",
      provider: "openworkflow",
    })
  })

  it("narrows OpenWorkflow get failures at the public boundary", async () => {
    const cause = new Error("provider-secret:get")
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: openWorkflowMock.OpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return {
          BackendSqlite: {
            connect: () => ({
              getWorkflowRun: async () => { throw cause },
              stop: vi.fn(),
            }),
          },
        } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(getWorkflowRun("welcome", "private-run"), cause, {
      operation: "get",
      provider: "openworkflow",
    })
  })

  it("narrows malformed OpenWorkflow get results at the public boundary", async () => {
    const cause = new Error("provider-secret:get-result")
    setOpenWorkflowImporter(async (specifier) => {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (specifier === "openworkflow") return { OpenWorkflow: openWorkflowMock.OpenWorkflow } as never
      if (specifier === "openworkflow/sqlite") {
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        return {
          BackendSqlite: {
            connect: () => ({
              getWorkflowRun: async () => ({
                get workflowName() {
                  throw cause
                },
              }),
              stop: vi.fn(),
            }),
          },
        } as never
      }
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      return await import(specifier) as never
    })
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    await expectProviderFailure(getWorkflowRun("welcome", "private-run"), cause, {
      operation: "get",
      provider: "openworkflow",
    })
  })

  it("preserves OpenWorkflow configuration errors", async () => {
    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: "https://provider.example/workflow.db" } })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })

    const error = await runWorkflow("welcome", {}).catch(error => error)

    expect(error).not.toBeInstanceOf(ViteHubError)
    expect(error).toEqual(new Error("OpenWorkflow SQLite storage requires a local SQLite file path, received \"https://provider.example/workflow.db\"."))
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

  it("registers OpenWorkflow handlers created in another JavaScript realm", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    // SAFETY: Node's VM evaluates the exact async function literal owned by this test fixture.
    const handler = runInNewContext("(async () => ({ ok: true }))") as () => Promise<{ ok: boolean }>
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler } }),
    })

    await createOpenWorkflowWorker()

    expect(openWorkflowMock.definitions.has("welcome")).toBe(true)
  })

  it("closes a partially started OpenWorkflow worker and normalizes startup failures", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const cause = new Error("worker startup failed")
    const stop = vi.fn(async () => {})
    openWorkflowMock.newWorker.mockReturnValueOnce({
      options: undefined,
      start: vi.fn(async () => { throw cause }),
      stop,
    })

    await expect(startOpenWorkflowWorker()).rejects.toMatchObject({
      cause,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "openworkflow" },
    })
    expect(stop).toHaveBeenCalledOnce()
  })

  it("keeps startup and cleanup failures when an OpenWorkflow worker cannot start", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const startError = new Error("worker startup failed")
    const stopError = new Error("worker cleanup failed")
    openWorkflowMock.newWorker.mockReturnValueOnce({
      options: undefined,
      start: vi.fn(async () => { throw startError }),
      stop: vi.fn(async () => { throw stopError }),
    })

    const error = await startOpenWorkflowWorker().catch(error => error)

    expect(error).toMatchObject({
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "openworkflow" },
    })
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect(error.cause.errors).toEqual([startError, stopError])
  })

  it("does not start and cleans up an OpenWorkflow worker for a pre-aborted signal", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const controller = new AbortController()
    const reason = new DOMException("cancelled", "AbortError")
    controller.abort(reason)
    const start = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    openWorkflowMock.newWorker.mockReturnValueOnce({ options: undefined, start, stop })

    await expect(startOpenWorkflowWorker({ signal: controller.signal })).rejects.toBe(reason)
    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("preserves an arbitrary abort reason while an OpenWorkflow worker starts", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const controller = new AbortController()
    const reason = new Error("cancelled")
    const start = vi.fn(() => new Promise<void>(() => {}))
    const stop = vi.fn(async () => {})
    openWorkflowMock.newWorker.mockReturnValueOnce({ options: undefined, start, stop })

    const workerTask = startOpenWorkflowWorker({ signal: controller.signal })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    controller.abort(reason)

    await expect(workerTask).rejects.toBe(reason)
    expect(stop).toHaveBeenCalledOnce()
  })

  it("stops a partially started OpenWorkflow worker when startup is aborted", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const controller = new AbortController()
    const reason = new DOMException("cancelled", "AbortError")
    const start = vi.fn(() => new Promise<void>(() => {}))
    const stop = vi.fn(async () => {})
    openWorkflowMock.newWorker.mockReturnValueOnce({ options: undefined, start, stop })

    const workerTask = startOpenWorkflowWorker({ signal: controller.signal })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    controller.abort(reason)

    await expect(workerTask).rejects.toBe(reason)
    expect(stop).toHaveBeenCalledOnce()
  })

  it("stops an OpenWorkflow worker again when startup succeeds after abort cleanup", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const controller = new AbortController()
    const reason = new DOMException("cancelled", "AbortError")
    let finishStart: (() => void) | undefined
    const start = vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve }))
    const stop = vi.fn(async () => {})
    openWorkflowMock.newWorker.mockReturnValueOnce({ options: undefined, start, stop })

    const workerTask = startOpenWorkflowWorker({ signal: controller.signal })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    controller.abort(reason)

    await expect(workerTask).rejects.toBe(reason)
    expect(stop).toHaveBeenCalledOnce()
    finishStart?.()
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2))
  })

  it("owns OpenWorkflow worker listeners until a cached public stop fails", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, "addEventListener")
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener")
    const processSignals = interceptProcessSignals()
    const cause = new Error("stop failed")
    const stop = vi.fn(async () => { throw cause })
    openWorkflowMock.newWorker.mockReturnValueOnce({
      options: undefined,
      start: vi.fn(async () => {}),
      stop,
    })

    const worker = await startOpenWorkflowWorker({
      signal: controller.signal,
    })

    expect(worker.start).toHaveBeenCalledOnce()
    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })

    const firstStop = worker.stop()
    const secondStop = worker.stop()

    expect(secondStop).toBe(firstStop)
    await expect(firstStop).rejects.toMatchObject({
      cause,
      code: "OPENWORKFLOW_WORKER_STOP_FAILED",
      details: { provider: "openworkflow" },
    })
    await expect(secondStop).rejects.toMatchObject({ cause })
    expect(stop).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function))
    expect(processSignals.off).toHaveBeenCalledTimes(2)

    controller.abort()
    expect(stop).toHaveBeenCalledOnce()
  })

  it("reports abort-triggered OpenWorkflow worker stop failures after removing listeners", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const cause = new Error("stop failed")
    const stop = vi.fn(async () => { throw cause })
    openWorkflowMock.newWorker.mockReturnValueOnce({
      options: undefined,
      start: vi.fn(async () => {}),
      stop,
    })
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener")
    const processSignals = interceptProcessSignals()
    const onError = vi.fn()

    await startOpenWorkflowWorker({ onError, signal: controller.signal })
    const sigint = processSignals.listeners.get("SIGINT")
    const sigterm = processSignals.listeners.get("SIGTERM")

    controller.abort()

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        cause,
        code: "OPENWORKFLOW_WORKER_STOP_FAILED",
        details: { provider: "openworkflow" },
      }))
    })
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ViteHubError)
    expect(stop).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function))
    expect(processSignals.off).toHaveBeenCalledWith("SIGINT", sigint)
    expect(processSignals.off).toHaveBeenCalledWith("SIGTERM", sigterm)
    expect(processSignals.on).toHaveBeenCalledTimes(2)
  })

  it("reports process-triggered OpenWorkflow worker stop failures without returning a promise to the host", async () => {
    setWorkflowRuntimeConfig({
      postgres: { url: "postgres://localhost/vitehub" },
      provider: "openworkflow",
    })
    const cause = new Error("stop failed")
    const stop = vi.fn(async () => { throw cause })
    openWorkflowMock.newWorker.mockReturnValueOnce({
      options: undefined,
      start: vi.fn(async () => {}),
      stop,
    })
    const processSignals = interceptProcessSignals()
    const onError = vi.fn()

    const worker = await startOpenWorkflowWorker({ onError })
    const sigint = processSignals.listeners.get("SIGINT")
    expect(sigint).toBeDefined()

    const returned = sigint?.()

    expect(returned).toBeUndefined()
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        cause,
        code: "OPENWORKFLOW_WORKER_STOP_FAILED",
      }))
    })
    await expect(worker.stop()).rejects.toMatchObject({
      cause,
      code: "OPENWORKFLOW_WORKER_STOP_FAILED",
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(processSignals.off).toHaveBeenCalledTimes(2)
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
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
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

  it("runs native Vercel entries durably and exposes run and step state", async () => {
    const createdAt = new Date("2026-07-15T10:00:00.000Z")
    const startedAt = new Date("2026-07-15T10:00:01.000Z")
    const completedAt = new Date("2026-07-15T10:00:02.000Z")
    let status = "pending"
    const native = Object.assign(vi.fn(async () => ({ ok: true })), { workflowId: "durable-welcome" })
    const otherNative = Object.assign(vi.fn(async () => ({ ok: true })), { workflowId: "durable-other" })
    const run: VercelRun = {
      cancel: vi.fn(async () => {
        status = "cancelled"
      }),
      completedAt: Promise.resolve(completedAt),
      createdAt: Promise.resolve(createdAt),
      exists: Promise.resolve(true),
      returnValue: Promise.resolve({ ok: true }),
      runId: "wdk-1",
      startedAt: Promise.resolve(startedAt),
      get status() {
        return Promise.resolve(status)
      },
      workflowName: Promise.resolve(native.workflowId),
    }
    const steps: VercelStep[] = [
      {
        attempt: 1,
        completedAt,
        error: JSON.stringify({ code: "TRANSCRIBE_FAILED", message: "Transcription failed." }),
        startedAt,
        status: "failed",
        stepId: "step-1",
        stepName: "transcribe",
      },
    ]
    const runtime: VercelWorkflowRuntime = {
      getRun: vi.fn(() => run),
      listSteps: vi.fn(async () => steps),
      resumeHook: vi.fn(async () => ({ runId: run.runId })),
      start: vi.fn(async () => run),
    }
    setVercelWorkflowRuntimeLoader(async () => runtime)
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: async () => ({ inline: true }),
          options: { native },
        },
      }),
      other: async () => ({
        default: { handler: async () => ({ inline: true }), options: { native: otherNative } },
      }),
    })

    const pending = await runWorkflow("welcome", { message: "hello" })
    expect(pending).toMatchObject({ id: "wdk-1", provider: "vercel", status: "queued" })
    expect(runtime.start).toHaveBeenCalledWith(native, [{ name: "welcome", payload: { message: "hello" }, provider: "vercel" }])

    status = "completed"
    await expect(getWorkflowRun("welcome", run.runId)).resolves.toMatchObject({
      completedAt,
      createdAt,
      id: "wdk-1",
      result: { ok: true },
      startedAt,
      status: "completed",
      steps: [{
        attempt: 1,
        error: { code: "TRANSCRIBE_FAILED", message: "Transcription failed." },
        id: "step-1",
        name: "transcribe",
        status: "failed",
      }],
    })

    await expect(resumeWorkflowSignal("opaque-provider-token", { ready: true })).resolves.toEqual({
      id: "wdk-1",
      provider: "vercel",
    })
    expect(runtime.resumeHook).toHaveBeenCalledWith("opaque-provider-token", { ready: true })

    await expect(getWorkflowRun("other", run.runId)).resolves.toEqual({
      id: "wdk-1",
      provider: "vercel",
      status: "unknown",
    })
    await expect(cancelWorkflow("other", run.runId)).resolves.toEqual({
      id: "wdk-1",
      provider: "vercel",
      status: "unknown",
    })
    expect(run.cancel).not.toHaveBeenCalled()

    await expect(cancelWorkflow("welcome", run.runId)).resolves.toMatchObject({
      status: "cancelled",
    })
    expect(run.cancel).toHaveBeenCalledTimes(1)
  })

  it("rejects caller-assigned ids for native Vercel entries", async () => {
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: vi.fn(),
      listSteps: vi.fn(async () => []),
      resumeHook: vi.fn(),
      start: vi.fn(),
    }) as never)
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async () => "inline", options: { native: async () => "native" } },
      }),
    })

    await expect(runWorkflow("welcome", {}, { id: "caller-id" })).rejects.toMatchObject({
      code: "WORKFLOW_RUN_ID_UNSUPPORTED",
      details: { name: "welcome", provider: "vercel" },
    })
  })

  it("normalizes unrecognized native Vercel states conservatively", async () => {
    const run: VercelRun = {
      cancel: vi.fn(),
      completedAt: Promise.resolve(undefined),
      createdAt: Promise.resolve(new Date()),
      exists: Promise.resolve(true),
      returnValue: Promise.resolve(undefined),
      runId: "wdk-unknown",
      startedAt: Promise.resolve(undefined),
      status: Promise.resolve("suspended"),
      workflowName: Promise.resolve("durable-welcome"),
    }
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: () => run,
      listSteps: async () => [{ attempt: 1, status: "waiting", stepId: "step-unknown", stepName: "wait" }],
      resumeHook: vi.fn(),
      start: vi.fn(async () => run),
    }))
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async () => "inline", options: { native: Object.assign(async () => "native", { workflowId: "durable-welcome" }) } },
      }),
    })

    await expect(getWorkflowRun("welcome", run.runId)).resolves.toMatchObject({
      status: "unknown",
      steps: [{ id: "step-unknown", status: "unknown" }],
    })
  })

  it("does not inspect unavailable properties on missing native Vercel runs", async () => {
    const native = Object.assign(async () => "native", { workflowId: "durable-welcome" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const run = {
      exists: Promise.resolve(false),
      get workflowName(): Promise<string> {
        throw new Error("missing run has no workflow name")
      },
    } as VercelRun
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: () => run,
      listSteps: vi.fn(),
      resumeHook: vi.fn(),
      start: vi.fn(),
    }) as never)
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => "inline", options: { native } } }),
    })

    await expect(getWorkflowRun("welcome", "missing")).resolves.toEqual({ id: "missing", provider: "vercel", status: "unknown" })
    await expect(cancelWorkflow("welcome", "missing")).resolves.toEqual({ id: "missing", provider: "vercel", status: "unknown" })
  })

  it("narrows malformed and hostile Vercel results at the provider boundary", async () => {
    const native = Object.assign(async () => "native", { workflowId: "durable-welcome" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const createRun = (overrides: Record<string, unknown> = {}) => ({
      cancel: vi.fn(),
      completedAt: Promise.resolve(undefined),
      createdAt: Promise.resolve(new Date()),
      exists: Promise.resolve(true),
      returnValue: Promise.resolve(undefined),
      runId: "wdk-malformed",
      startedAt: Promise.resolve(undefined),
      status: Promise.resolve("pending"),
      workflowName: Promise.resolve(native.workflowId),
      ...overrides,
    }) as VercelRun
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async () => "inline", options: { native } },
      }),
    })

    const invalidRuns: [Record<string, unknown>, string][] = [
      [{ exists: Promise.resolve("yes") }, "existence state"],
      [{ workflowName: Promise.resolve(42) }, "workflow name"],
      [{ status: Promise.resolve(42) }, "status"],
      [{ createdAt: Promise.resolve("today") }, "creation date"],
      [{ startedAt: Promise.resolve("today") }, "start date"],
      [{ completedAt: Promise.resolve("today") }, "completion date"],
    ]
    for (const [overrides, field] of invalidRuns) {
      setVercelWorkflowRuntimeLoader(async () => ({
        getRun: () => createRun(overrides),
        listSteps: async () => [],
        resumeHook: vi.fn(),
        start: vi.fn(),
      }))
      await expectInvalidProviderResult(getWorkflowRun("welcome", "wdk-malformed"), "get-run", field)
    }

    const step = {
      attempt: 1,
      status: "pending",
      stepId: "step-1",
      stepName: "transcribe",
    }
    const invalidSteps: [unknown, string][] = [
      [{ not: "an array" }, "step list"],
      [[null], "step"],
      [[{ ...step, attempt: "one" }], "step attempt"],
      [[{ ...step, stepId: 42 }], "step ID"],
      [[{ ...step, stepName: 42 }], "step name"],
      [[{ ...step, completedAt: "today" }], "step completion date"],
      [[{ ...step, startedAt: "today" }], "step start date"],
      [[{ ...step, status: 42 }], "status"],
    ]
    for (const [steps, field] of invalidSteps) {
      setVercelWorkflowRuntimeLoader(async () => ({
        getRun: () => createRun(),
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        listSteps: async () => steps as never,
        resumeHook: vi.fn(),
        start: vi.fn(),
      }))
      await expectInvalidProviderResult(getWorkflowRun("welcome", "wdk-malformed"), "list-steps", field)
    }

    const stepCause = new Error("provider-secret:step-result")
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: () => createRun(),
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      listSteps: async () => [new Proxy({}, { get: () => { throw stepCause } })] as never,
      resumeHook: vi.fn(),
      start: vi.fn(),
    }))
    await expectProviderFailure(getWorkflowRun("welcome", "wdk-malformed"), stepCause, {
      operation: "list-steps",
      provider: "vercel",
    })

    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: vi.fn(),
      listSteps: vi.fn(),
      resumeHook: vi.fn(),
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      start: async () => ({ runId: 42 }) as never,
    }))
    await expectInvalidProviderResult(runWorkflow("welcome", {}), "start", "run ID")

    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: vi.fn(),
      listSteps: vi.fn(),
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      resumeHook: async () => ({ runId: 42 }) as never,
      start: vi.fn(),
    }))
    await expectInvalidProviderResult(resumeWorkflowSignal("opaque", {}), "resume-signal", "run ID")
  })

  it("fails unsupported inline cancellation and non-Vercel signals explicitly", async () => {
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => "inline" } }),
    })
    setWorkflowRuntimeConfig({ provider: "vercel" })
    await expect(cancelWorkflow("welcome", "inline-1")).rejects.toMatchObject({
      code: "WORKFLOW_OPERATION_UNSUPPORTED",
    })

    setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
    await expect(resumeWorkflowSignal("opaque", {})).rejects.toMatchObject({
      code: "WORKFLOW_OPERATION_UNSUPPORTED",
    })
  })

  it("reports a missing optional Vercel Workflow DevKit explicitly", async () => {
    setVercelWorkflowRuntimeLoader(async () => {
      throw new Error("Cannot find package 'workflow'")
    })
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async () => "inline", options: { native: async () => "native" } },
      }),
    })

    await expect(getWorkflowRun("welcome", "missing-sdk")).rejects.toMatchObject({
      code: "VERCEL_WORKFLOW_SDK_LOAD_FAILED",
      details: { provider: "vercel" },
    })
  })

  it("preserves custom and abort errors from the Vercel runtime loader", async () => {
    const custom = new ViteHubError("CUSTOM_RUNTIME_LOAD_FAILED", "Custom load failure.")
    const abort = new DOMException("cancelled", "AbortError")
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async () => "inline", options: { native: async () => "native" } },
      }),
    })

    setVercelWorkflowRuntimeLoader(async () => {
      throw custom
    })
    await expect(getWorkflowRun("welcome", "custom")).rejects.toBe(custom)

    setVercelWorkflowRuntimeLoader(async () => {
      throw abort
    })
    await expect(getWorkflowRun("welcome", "abort")).rejects.toBe(abort)
  })

  it("narrows every Vercel provider operation at the public boundary", async () => {
    const native = Object.assign(async () => "native", { workflowId: "durable-welcome" })
    const createRun = (cancel: () => Promise<void> = async () => {}) => ({
      cancel,
      completedAt: Promise.resolve(undefined),
      createdAt: Promise.resolve(new Date("2026-07-18T00:00:00.000Z")),
      exists: Promise.resolve(true),
      returnValue: Promise.resolve(undefined),
      runId: "wdk-provider-failure",
      startedAt: Promise.resolve(undefined),
      status: Promise.resolve("pending"),
      workflowName: Promise.resolve(native.workflowId),
    } satisfies VercelRun)
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({
        default: { handler: async () => "inline", options: { native } },
      }),
    })

    const getRunCause = Object.assign(new Error("provider-secret:get-run"), { status: 502 })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: () => { throw getRunCause },
      listSteps: vi.fn(),
      resumeHook: vi.fn(),
      start: vi.fn(),
    }) as never)
    await expectProviderFailure(getWorkflowRun("welcome", "private-run"), getRunCause, {
      operation: "get-run",
      provider: "vercel",
      status: 502,
    })

    const listCause = new Error("provider-secret:list-steps")
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: () => createRun(),
      listSteps: async () => { throw listCause },
      resumeHook: vi.fn(),
      start: vi.fn(),
    }))
    await expectProviderFailure(getWorkflowRun("welcome", "private-run"), listCause, {
      operation: "list-steps",
      provider: "vercel",
    })

    const startCause = new Error("provider-secret:start")
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: vi.fn(),
      listSteps: vi.fn(),
      resumeHook: vi.fn(),
      start: async () => { throw startCause },
    }) as never)
    await expectProviderFailure(runWorkflow("welcome", {}), startCause, {
      operation: "start",
      provider: "vercel",
    })

    const cancelCause = new Error("provider-secret:cancel")
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: () => createRun(async () => { throw cancelCause }),
      listSteps: vi.fn(),
      resumeHook: vi.fn(),
      start: vi.fn(),
    }))
    await expectProviderFailure(cancelWorkflow("welcome", "private-run"), cancelCause, {
      operation: "cancel",
      provider: "vercel",
    })

    const resumeCause = new Error("provider-secret:resume")
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    setVercelWorkflowRuntimeLoader(async () => ({
      getRun: vi.fn(),
      listSteps: vi.fn(),
      resumeHook: async () => { throw resumeCause },
      start: vi.fn(),
    }) as never)
    await expectProviderFailure(resumeWorkflowSignal("private-token", {}), resumeCause, {
      operation: "resume-signal",
      provider: "vercel",
    })
  })

  it("narrows every Cloudflare provider operation at the public boundary", async () => {
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CUSTOM", provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    const enterBinding = (binding: unknown) => enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: { WORKFLOW_CUSTOM: binding } } } },
    })

    const getCause = new Error("provider-secret:get")
    enterBinding({ createBatch: vi.fn(), get: async () => { throw getCause } })
    await expectProviderFailure(getWorkflowRun("welcome", "private-run"), getCause, {
      operation: "get",
      provider: "cloudflare",
    })

    const statusCause = new Error("provider-secret:status")
    enterBinding({
      createBatch: vi.fn(),
      get: async () => ({ id: "private-run", status: async () => { throw statusCause } }),
    })
    await expectProviderFailure(getWorkflowRun("welcome", "private-run"), statusCause, {
      operation: "status",
      provider: "cloudflare",
    })

    const createCause = new Error("provider-secret:create")
    enterBinding({ createBatch: async () => { throw createCause }, get: vi.fn() })
    await expectProviderFailure(runWorkflow("welcome", {}), createCause, {
      acknowledgement: "unknown",
      operation: "create",
      provider: "cloudflare",
    })
  })

  it("honors custom bindings for user Workflows with recovery-like names", async () => {
    const name = "vitehub-agent-invocation-recovery-user-defined"
    const createBatch = vi.fn(async () => [{ id: "custom-run", status: async () => "queued" }])
    const get = vi.fn(async () => ({ id: "custom-run", status: async () => "complete" }))
    const generatedGet = vi.fn(async () => ({ id: "generated-run", status: async () => "failed" }))
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CUSTOM", provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      [name]: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: {
        [getCloudflareWorkflowBindingName(name)]: { createBatch: vi.fn(), get: generatedGet },
        WORKFLOW_CUSTOM: { createBatch, get },
      } } } },
    })

    await expect(runWorkflow(name, {}, { id: "custom-run" })).resolves.toMatchObject({ id: "custom-run" })
    await expect(getWorkflowRun(name, "custom-run")).resolves.toMatchObject({ id: "custom-run", status: "completed" })
    expect(createBatch).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledOnce()
    expect(generatedGet).not.toHaveBeenCalled()
  })

  it("inspects Cloudflare runs without evaluating their handler modules", async () => {
    const name = "vitehub-agent-invocation-recovery-welcome"
    const load = vi.fn(async () => { throw new Error("module startup failed") })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    Object.assign(load, { internalAgentInvocationRecovery: true as const })
    const status = vi.fn(async () => "complete")
    const generatedGet = vi.fn(async () => ({ id: "recovery-run", status }))
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CUSTOM", provider: "cloudflare" })
    setWorkflowRuntimeRegistry({ [name]: load })
    enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: {
        [getCloudflareWorkflowBindingName(name)]: {
          createBatch: vi.fn(),
          get: generatedGet,
        },
        WORKFLOW_CUSTOM: { createBatch: vi.fn(), get: vi.fn(async () => ({ id: "custom-run", status })) },
      } } } },
    })

    await expect(getWorkflowRun(name, "recovery-run")).resolves.toMatchObject({
      id: "recovery-run",
      provider: "cloudflare",
      status: "completed",
    })
    expect(load).not.toHaveBeenCalled()
    expect(generatedGet).toHaveBeenCalledOnce()
  })

  it("starts generated Cloudflare Agent Invocation recovery through its generated binding", async () => {
    const name = "vitehub-agent-invocation-recovery-welcome"
    const generatedCreateBatch = vi.fn(async () => [{ id: "recovery-run", status: async () => "queued" }])
    const customCreateBatch = vi.fn(async () => [{ id: "custom-run", status: async () => "queued" }])
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CUSTOM", provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      [name]: Object.assign(async () => ({
        // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
        internalAgentInvocationRecovery: true as const,
        handler: async () => ({ ok: true }),
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      }), { internalAgentInvocationRecovery: true as const }),
    })
    enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: {
        [getCloudflareWorkflowBindingName(name)]: { createBatch: generatedCreateBatch, get: vi.fn() },
        WORKFLOW_CUSTOM: { createBatch: customCreateBatch, get: vi.fn() },
      } } } },
    })

    await expect(runWorkflow(name, {}, { id: "recovery-run" })).resolves.toMatchObject({ id: "recovery-run" })
    expect(generatedCreateBatch).toHaveBeenCalledOnce()
    expect(customCreateBatch).not.toHaveBeenCalled()
  })

  it("keeps an acknowledged Cloudflare start queued when status inspection is unavailable", async () => {
    const status = vi.fn(async () => { throw new Error("status unavailable") })
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CUSTOM", provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: { WORKFLOW_CUSTOM: {
        createBatch: async () => [{ id: "accepted-run", status }],
        get: vi.fn(),
      } } } } },
    })

    await expect(runWorkflow("welcome", {}, { id: "accepted-run" })).resolves.toMatchObject({
      id: "accepted-run",
      provider: "cloudflare",
      status: "queued",
    })
    expect(status).not.toHaveBeenCalled()
  })

  it("omits unsafe workflow names and caller run IDs from public errors", async () => {
    const unsafeName = "https://provider.example/private?token=provider-secret"
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({})

    const missing = await runWorkflow(unsafeName, {}).catch(error => error)
    expect(JSON.parse(JSON.stringify(missing))).toEqual({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
      message: "Workflow definition was not found.",
      name: "ViteHubError",
    })

    setWorkflowRuntimeRegistry({
      [unsafeName]: async () => ({
        default: { handler: async () => "inline", options: { native: async () => "native" } },
      }),
    })
    const unsupportedId = await runWorkflow(unsafeName, {}, { id: "provider-secret-run-id" }).catch(error => error)
    expect(JSON.parse(JSON.stringify(unsupportedId))).toEqual({
      code: "WORKFLOW_RUN_ID_UNSUPPORTED",
      details: { provider: "vercel" },
      message: "Native Vercel workflows assign their own run IDs.",
      name: "ViteHubError",
    })
  })

  it("rejects invalid workflow module shapes as missing definitions", async () => {
    setWorkflowRuntimeConfig({ provider: "vercel" })
    setWorkflowRuntimeRegistry({
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      welcome: async () => ({ named: { handler: async () => ({ ok: true }) } }) as never,
    })

    await expect(runWorkflow("welcome", {})).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
    })
  })

  it("validates Cloudflare workflow names before binding dispatch", async () => {
    const createBatch = vi.fn()
    setWorkflowRuntimeConfig({ binding: "WORKFLOW_CUSTOM", provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            env: {
              WORKFLOW_CUSTOM: { createBatch, get: vi.fn() },
            },
          },
        },
      },
    })

    await expect(runWorkflow("welcom", {}, { id: "typo" })).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
    })
    expect(createBatch).not.toHaveBeenCalled()
  })

  it("returns unknown when inline Vercel run state is unavailable", async () => {
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
    const createBatch = vi.fn(async ([{ id }]: Array<{ id: string }>) => [{
      id: id!,
      status: vi.fn(async () => ({ status: "queued" })),
    }])
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
              [getCloudflareWorkflowBindingName("welcome")]: { createBatch, get: vi.fn() },
            },
          },
        },
        waitUntil,
      },
    })

    await deferWorkflow("welcome", { email: "ava@example.com" }, { id: "welcome-1" })

    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    expect(createBatch).toHaveBeenCalledWith([{
      id: "welcome-1",
      params: { email: "ava@example.com" },
    }])
  })

  it("recovers Cloudflare runs after a lost creation acknowledgement", async () => {
    const instance = { id: "welcome-1", status: vi.fn(async () => ({ status: "queued" })) }
    const createBatch = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce([])
    const get = vi.fn(async () => instance)
    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            env: { [getCloudflareWorkflowBindingName("welcome")]: { createBatch, get } },
          },
        },
      },
    })

    await expect(runWorkflow("welcome", {}, { id: "welcome-1" })).resolves.toMatchObject({
      id: "welcome-1",
      status: "queued",
    })
    expect(createBatch).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith("welcome-1")
  })

  it("preserves a lost Cloudflare acknowledgement when the retry is rejected", async () => {
    const lostAcknowledgement = new Error("connection closed")
    const retryFailure = Object.assign(new Error("already exists"), { status: 409 })
    const createBatch = vi.fn()
      .mockRejectedValueOnce(lostAcknowledgement)
      .mockRejectedValueOnce(retryFailure)
    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    setWorkflowRuntimeRegistry({
      welcome: async () => ({ default: { handler: async () => ({ ok: true }) } }),
    })
    enterWorkflowRuntimeEvent({
      req: { runtime: { cloudflare: { env: {
        [getCloudflareWorkflowBindingName("welcome")]: { createBatch, get: vi.fn() },
      } } } },
    })

    await expectProviderFailure(runWorkflow("welcome", {}, { id: "welcome-1" }), lostAcknowledgement, {
      acknowledgement: "unknown",
      operation: "create",
      provider: "cloudflare",
    })
    expect(createBatch).toHaveBeenCalledTimes(2)
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
              [getCloudflareWorkflowBindingName("welcome")]: { createBatch: vi.fn(), get },
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
