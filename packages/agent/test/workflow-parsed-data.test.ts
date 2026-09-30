import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, runAgentInline, startAgentInvocation, workflow } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

afterEach(() => {
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
})

describe("durable Agent data handoff", () => {
  it("parses data once across preflight and the durable Workflow", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({ data, driver: { run }, runtime: workflow("parsed-data-preflight") })
    let payload: unknown
    setAgentWorkflowRuntimeLoaders({
      state: async () => ({
        ...await import("@vite-hub/workflow/runtime/state"),
        getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }),
      }),
      workflow: async () => ({
        ...await import("@vite-hub/workflow"),
        createWorkflow: () => ({
          run: async (input: unknown) => {
            payload = input
            return { id: "parsed-data-preflight", provider: "openworkflow", status: "queued" }
          },
        }) as never,
      }),
    })

    await startAgentInvocation(agent, {
      memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn(),
    }, { data: { count: "2" } })

    expect(payload).toMatchObject({ input: { data: { count: 2 } }, parsedInputData: true })
    expect(validate).toHaveBeenCalledOnce()
    const result = await runAgentWorkflowDefinition(agent, {
      id: "parsed-data-preflight",
      name: "parsed-data-preflight",
      payload: payload as never,
      provider: "openworkflow",
    }, runAgentInline)

    expect(result).toEqual({ count: 2 })
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it("passes pre-parsed data to the Driver without parsing it again", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({ data, driver: { run }, runtime: false })
    const parsedData = v.parse(data, { count: "2" })

    const result = await runAgentWorkflowDefinition(agent, {
      id: "parsed-data",
      name: "parsed-data",
      payload: { input: { data: parsedData }, parsedInputData: true },
      provider: "cloudflare",
    }, runAgentInline)

    expect(result).toEqual({ count: 2 })
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it("hands off raw data when the transformed value is not portable", async () => {
    const data = v.object({ date: v.pipe(v.string(), v.transform(value => new Date(value))) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => ({ isDate: input.data && typeof input.data === "object" && "date" in input.data && input.data.date instanceof Date }))
    const agent = defineAgent({ data, driver: { run }, runtime: workflow("nonportable-data") })
    let payload: unknown
    setAgentWorkflowRuntimeLoaders({
      state: async () => ({
        ...await import("@vite-hub/workflow/runtime/state"),
        getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }),
      }),
      workflow: async () => ({
        ...await import("@vite-hub/workflow"),
        createWorkflow: () => ({
          run: async (input: unknown) => {
            payload = input
            return { id: "nonportable-data", provider: "openworkflow", status: "queued" }
          },
        }) as never,
      }),
    })

    await startAgentInvocation(agent, {
      memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn(),
    }, { data: { date: "2026-01-01T00:00:00.000Z" } })

    expect(payload).toMatchObject({ input: { data: { date: "2026-01-01T00:00:00.000Z" } } })
    expect(payload).not.toHaveProperty("parsedInputData")
    const result = await runAgentWorkflowDefinition(agent, {
      id: "nonportable-data",
      name: "nonportable-data",
      payload: payload as never,
      provider: "openworkflow",
    }, runAgentInline)

    expect(result).toEqual({ isDate: true })
    expect(run).toHaveBeenCalledOnce()
  })

  it("validates older payloads and ignores caller-supplied input context", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const agent = defineAgent({ data, driver: { run: ({ input }) => input.data }, runtime: false })
    const marker = "vitehub.agent.workflow.parsedInputData"
    const input = { context: { [marker]: true }, data: { count: "3" } }
    const result = await runAgentWorkflowDefinition(agent, {
      id: "legacy-data",
      name: "legacy-data",
      payload: { input },
      provider: "cloudflare",
    }, async (definition, context, workflowInput) => {
      expect(Reflect.get(context, Symbol.for(marker))).toBeUndefined()
      return runAgentInline(definition, context, workflowInput)
    })

    expect(result).toEqual({ count: 3 })
    expect(validate).toHaveBeenCalledOnce()
  })

  it("scopes parsed data to the Agent that crossed the Workflow boundary", async () => {
    const childRun = vi.fn(() => "child")
    const child = defineAgent({
      data: v.object({ count: v.string() }),
      driver: { run: childRun },
      runtime: false,
    })
    const parent = defineAgent({
      data: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
      driver: { run: () => "parent" },
      hooks: {
        "agent:input": async (context) => {
          await runAgentInline(child, context, { data: { count: 1 } as never })
        },
      },
      runtime: false,
    })

    await expect(runAgentWorkflowDefinition(parent, {
      id: "nested-agent-data",
      name: "nested-agent-data",
      payload: { input: { data: { count: "2" } }, parsedInputData: true },
      provider: "cloudflare",
    }, runAgentInline)).rejects.toThrow("Invalid Agent input data")
    expect(childRun).not.toHaveBeenCalled()
  })

  it("validates nested invocations of the same Workflow Agent", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const nestedResults: unknown[] = []
    const agent = defineAgent({
      data,
      driver: { run },
      hooks: {
        "agent:input": async (context) => {
          if (context.input.data?.count !== 2) return
          await expect(runAgentInline(agent, context, { data: { count: 1 } as never })).rejects.toThrow("Invalid Agent input data")
          nestedResults.push(await runAgentInline(agent, context, { data: { count: "3" } }))
        },
      },
      runtime: false,
    })
    const parsedData = v.parse(data, { count: "2" })

    const result = await runAgentWorkflowDefinition(agent, {
      id: "recursive-agent-data",
      name: "recursive-agent-data",
      payload: { input: { data: parsedData }, parsedInputData: true },
      provider: "cloudflare",
    }, runAgentInline)

    expect(result).toEqual({ count: 2 })
    expect(nestedResults).toEqual([{ count: 3 }])
    expect(validate).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("rejects caller-forged parsed input markers", async () => {
    const run = vi.fn(() => "invalid")
    const agent = defineAgent({ data: v.string(), driver: { run }, runtime: false })
    const input = { data: 1 as never, [Symbol.for("vitehub.agent.workflow.parsedInputData")]: agent }

    await expect(runAgentInline(agent, {
      memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn(),
    }, input)).rejects.toThrow("Invalid Agent input data")
    expect(run).not.toHaveBeenCalled()
  })

  it("consumes the parsed input exemption for one invocation", async () => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({ data, driver: { run }, runtime: false })
    const parsedData = v.parse(data, { count: "2" })

    const result = await runAgentWorkflowDefinition(agent, {
      id: "one-shot-agent-data",
      name: "one-shot-agent-data",
      payload: { input: { data: parsedData }, parsedInputData: true },
      provider: "cloudflare",
    }, async (definition, context, input) => {
      const output = await runAgentInline(definition, context, input)
      await expect(runAgentInline(definition, context, input)).rejects.toThrow("Invalid Agent input data")
      return output
    })

    expect(result).toEqual({ count: 2 })
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it.each(["metadata", "invoker", "both"])("preserves parsed data after restoring %s", async (restoration) => {
    const validate = vi.fn((value: string) => Number(value))
    const data = v.object({ count: v.pipe(v.string(), v.transform(validate)) })
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({
      data,
      driver: { run },
      messages: { meta: v.object({ label: v.string() }), metaRevision: "data-v1" },
      runtime: false,
    })
    const parsedData = v.parse(data, { count: "2" })

    const result = await runAgentWorkflowDefinition(agent, {
      id: "restored-agent-data",
      name: "restored-agent-data",
      payload: {
        input: { data: parsedData, context: { channel: { meta: { label: "parsed" } } } },
        parsedInputData: true,
        ...(restoration !== "invoker" ? { parsedMessageMeta: { revision: "data-v1" } } : {}),
        ...(restoration !== "metadata" ? { resolvedInvoker: true } : {}),
      },
      provider: "cloudflare",
    }, runAgentInline)

    expect(result).toEqual({ count: 2 })
    expect(validate).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })
})
