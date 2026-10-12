import { createTraceEventLog } from "@vite-hub/runtime"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent, defineCapability, runAgent, runAgentInline, runAgentTrigger } from "../src/index.ts"

const emailSchema = v.object({
  from: v.string(),
  subject: v.string(),
})

const decisionSchema = v.object({ label: v.string() })

function runtime(content: "content" | "metadata" = "content") {
  return {
    memo: <T>(_key: string, create: () => T) => create(),
    runtime: "unknown" as const,
    traceLog: createTraceEventLog({ content }),
    waitUntil: vi.fn(),
  }
}

// Custom-run Drivers receive the parsed data as `unknown`.
function labeller(run = vi.fn((_context: { input: { data?: unknown } }) => ({ label: "jev" })), finish = vi.fn()) {
  return defineAgent({
    data: emailSchema,
    driver: { output: { schema: decisionSchema }, run },
    hooks: { "agent:finish": finish },
    intercept: ({ data }) => data.from.endsWith("@github.com") ? { rule: "github", label: "GitHub" } : undefined,
    runtime: false,
  })
}

function interceptChannel(options: { omitMessage?: boolean } = {}) {
  const messageSchema = v.pipe(v.object({
    from: v.string(),
    subject: v.string(),
  }), v.transform(message => ({ ...message, subject: message.subject.toUpperCase() })))
  return defineChannel("mail", {
    message: { data: messageSchema },
    messages: false,
    triggers: {
      received: defineChannelTrigger({
        input: v.object({
          data: v.optional(v.object({ marker: v.string() })),
          message: v.optional(v.looseObject({ subject: v.string() })),
        }),
        invoke(context, input) {
          return {
            input: {
              prompt: input.message?.subject,
              ...(input.data ? { data: input.data } : {}),
            },
            ...(options.omitMessage ? {} : { message: input.message }),
            run: {
              channelId: context.trigger.channelId,
              origin: context.channel.kind,
              runId: "mail-run",
            },
          }
        },
      }),
    },
  })
}

describe("Agent data and intercept", () => {
  it("rejects invalid data before the Driver runs", async () => {
    const run = vi.fn(() => ({ label: "jev" }))
    const intercept = vi.fn(() => undefined)
    const agent = defineAgent({
      data: emailSchema,
      driver: { run },
      intercept,
      runtime: false,
    })

    // @ts-expect-error The data schema requires a subject.
    const [error, output] = await runAgent(agent, { data: { from: "a@example.com" } })

    expect(output).toBeNull()
    expect(error?.message).toContain("Invalid Agent input data")
    expect(intercept).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("finishes with the intercepted value and skips the Driver", async () => {
    const run = vi.fn((_context: { input: { data?: unknown } }) => ({ label: "jev" }))
    const finish = vi.fn()
    const context = runtime()
    const output = await runAgentInline(labeller(run, finish), context, {
      data: { from: "notifications@github.com", subject: "PR merged" },
      prompt: "notifications@github.com: PR merged",
    })

    expect(output).toEqual({ label: "GitHub", rule: "github" })
    expect(run).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ data: { from: "notifications@github.com", subject: "PR merged" } }),
      result: { label: "GitHub", rule: "github" },
    }))
    const finished = context.traceLog.entries().find(entry => entry.name === "agent.invocation.finish")
    expect(finished?.attributes).toMatchObject({
      "agent.intercepted": true,
      "result.output": { label: "GitHub", rule: "github" },
    })
  })

  it("continues to the Driver when intercept returns undefined", async () => {
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => ({ label: `jev:${v.parse(emailSchema, input.data).subject}` }))
    const [error, output] = await runAgent(labeller(run), {
      data: { from: "friend@example.com", subject: "Dinner" },
    })

    expect(error).toBeNull()
    expect(output).toEqual({ label: "jev:Dinner" })
    expect(run).toHaveBeenCalledOnce()
  })

  it("passes parsed data to intercept, hooks, and the Driver", async () => {
    const seen: unknown[] = []
    const agent = defineAgent({
      data: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
      driver: { run: ({ input }) => { seen.push(input.data); return "ok" } },
      hooks: { "agent:input": ({ input }) => { seen.push(input.data) } },
      intercept: ({ data }) => { seen.push(data); return undefined },
      runtime: false,
    })

    await runAgentInline(agent, runtime(), { data: { count: "2" } })

    expect(seen).toEqual([{ count: 2 }, { count: 2 }, { count: 2 }])
  })

  it("validates and transforms a Channel message before intercept", async () => {
    const message = { from: "friend@example.com", subject: "Dinner" }
    const intercept = vi.fn(({ data }) => data.subject)
    const agent = defineAgent({
      channels: { mail: interceptChannel() },
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    await expect(runAgentTrigger(agent, runtime(), "mail.received", { message })).resolves.toBe("DINNER")
    expect(intercept).toHaveBeenCalledWith(expect.objectContaining({ data: { from: message.from, subject: "DINNER" } }))
  })

  it("rejects an invalid Channel message before intercept", async () => {
    const intercept = vi.fn(({ data }) => data)
    const agent = defineAgent({
      channels: { mail: interceptChannel() },
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    await expect(runAgentTrigger(agent, runtime(), "mail.received", { message: { subject: "Dinner" } })).rejects.toThrow(/Channel "mail" message data/)
    expect(intercept).not.toHaveBeenCalled()
  })

  it("validates a missing Channel message before intercept", async () => {
    const intercept = vi.fn(({ data }) => data)
    const agent = defineAgent({
      channels: { mail: interceptChannel({ omitMessage: true }) },
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    await expect(runAgentTrigger(agent, runtime(), "mail.received", { message: { subject: "Dinner" } })).rejects.toThrow(/Channel "mail" message data/)
    expect(intercept).not.toHaveBeenCalled()
  })

  it("keeps explicit invocation data for intercept when a Channel message exists", async () => {
    const message = { from: "friend@example.com", subject: "Dinner" }
    const data = { marker: "explicit" }
    const intercept = vi.fn(({ data: intercepted }) => intercepted)
    const agent = defineAgent({
      channels: { mail: interceptChannel() },
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    await expect(runAgentTrigger(agent, runtime(), "mail.received", { data, message })).resolves.toEqual(data)
    expect(intercept).toHaveBeenCalledWith(expect.objectContaining({ data }))
  })

  it.each(["absent", "invalid"])("keeps explicit invocation data when the Channel message is %s", async (messageKind) => {
    const data = { marker: "explicit" }
    const intercept = vi.fn(({ data: intercepted }) => intercepted)
    const agent = defineAgent({
      channels: { mail: interceptChannel({ omitMessage: messageKind === "absent" }) },
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    await expect(runAgentTrigger(agent, runtime(), "mail.received", {
      data,
      ...(messageKind === "invalid" ? { message: { subject: "Dinner" } } : {}),
    })).resolves.toEqual(data)
    expect(intercept).toHaveBeenCalledWith(expect.objectContaining({ data }))
  })

  it("does not bypass an explicit input data schema for Channel message fallback", async () => {
    const message = { from: "friend@example.com", subject: "Dinner" }
    const intercept = vi.fn(({ data }) => data)
    const agent = defineAgent({
      channels: { mail: interceptChannel() },
      data: v.optional(v.object({ marker: v.string() })),
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    await expect(runAgentTrigger(agent, runtime(), "mail.received", { message })).resolves.toBe("driver")
    expect(intercept).toHaveBeenCalledWith(expect.objectContaining({ data: undefined }))
  })

  it("leaves Channel fallback data absent for direct invocations", async () => {
    const intercept = vi.fn(({ data }) => data === undefined ? "handled" : data)
    const agent = defineAgent({
      channels: { mail: interceptChannel() },
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    await expect(runAgent(agent, runtime(), { prompt: "direct" })).resolves.toBe("handled")
    expect(intercept).toHaveBeenCalledWith(expect.objectContaining({ data: undefined }))
  })

  it.each(["handled", "driver"])("leaves a missing Capability trigger message absent when intercept selects %s", async (result) => {
    const intercept = vi.fn(({ data }) => {
      expect(data).toBeUndefined()
      return result === "handled" ? "handled" : undefined
    })
    const run = vi.fn(() => "driver")
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "background",
        triggers: {
          requested: {
            invoke: () => ({
              input: { prompt: "background work" },
              run: { channelId: "mail", origin: "background", runId: "background-run" },
            }),
          },
        },
      })],
      channels: { mail: interceptChannel() },
      driver: { run },
      intercept,
      runtime: false,
    })

    await expect(runAgentTrigger(agent, runtime(), "background.requested", {})).resolves.toBe(result)
    expect(intercept).toHaveBeenCalledOnce()
    if (result === "handled") expect(run).not.toHaveBeenCalled()
    else expect(run).toHaveBeenCalledOnce()
  })

  it.each(["replace", "clear", "mutate"])("revalidates data changed by an input hook through %s", async (change) => {
    const run = vi.fn(() => "ok")
    const close = vi.fn()
    const agent = defineAgent({
      capabilities: [defineCapability({ id: "hook-data-validation", close })],
      data: emailSchema,
      driver: { run },
      hooks: { "agent:input": ({ input }) => {
        if (change === "clear") input.data = undefined
        else if (change === "replace") Reflect.set(input, "data", { from: "invalid" })
        else if (input.data) Reflect.deleteProperty(input.data, "subject")
      } },
      intercept: () => ({ intercepted: true }),
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "friend@example.com", subject: "Dinner" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("does not reparse transformed data after an unchanged input hook without interception", async () => {
    const transform = vi.fn(Number)
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({
      data: v.object({ count: v.pipe(v.string(), v.transform(transform)) }),
      driver: { run },
      hooks: { "agent:input": () => {} },
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { count: "2" } })

    expect(error).toBeNull()
    expect(output).toEqual({ count: 2 })
    expect(transform).toHaveBeenCalledOnce()
  })

  it("rejects transformed output changed by an input hook", async () => {
    const transform = vi.fn(Number)
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({
      data: v.object({ count: v.pipe(v.string(), v.transform(transform)) }),
      driver: { run },
      hooks: { "agent:input": ({ input }) => { input.data = { count: 3 } } },
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { count: "2" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(transform).toHaveBeenCalledOnce()
  })

  it("rejects transformed output that violates its constraint after an input hook", async () => {
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({
      data: v.pipe(v.string(), v.transform(Number), v.minValue(1)),
      driver: { run },
      hooks: { "agent:input": ({ input }) => { input.data = -1 } },
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: "2" })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it("validates data replaced by a Capability before hooks and intercept", async () => {
    const inputHook = vi.fn()
    const intercept = vi.fn(() => undefined)
    const run = vi.fn(() => "ok")
    const replaceData = defineCapability({
      id: "replace-data",
      input(context) {
        context.input.set({ ...context.input.get(), data: { from: "invalid" } })
      },
    })
    const agent = defineAgent({
      capabilities: [replaceData],
      data: emailSchema,
      driver: { run },
      hooks: { "agent:input": inputHook },
      intercept,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "friend@example.com", subject: "Dinner" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(inputHook).not.toHaveBeenCalled()
    expect(intercept).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("validates data mutated in place by a Capability before hooks and intercept", async () => {
    const inputHook = vi.fn()
    const intercept = vi.fn(() => undefined)
    const run = vi.fn(() => "ok")
    const mutateData = defineCapability({
      id: "mutate-data",
      input(context) {
        const data = context.input.get().data as { subject?: string }
        delete data.subject
      },
    })
    const agent = defineAgent({
      capabilities: [mutateData],
      data: emailSchema,
      driver: { run },
      hooks: { "agent:input": inputHook },
      intercept,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "friend@example.com", subject: "Dinner" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(inputHook).not.toHaveBeenCalled()
    expect(intercept).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("validates data mutated in place by intercept before the Driver runs", async () => {
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      data: emailSchema,
      driver: { run },
      intercept: ({ data }) => {
        delete (data as { subject?: string }).subject
        return undefined
      },
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "friend@example.com", subject: "Dinner" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it("validates data mutated in place by a handled intercept before finishing", async () => {
    const finish = vi.fn()
    const agent = defineAgent({
      data: emailSchema,
      driver: { run: vi.fn(() => "unused") },
      hooks: { "agent:finish": finish },
      intercept: ({ data }) => {
        delete (data as { subject?: string }).subject
        return { intercepted: true }
      },
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "friend@example.com", subject: "Dinner" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(finish).not.toHaveBeenCalled()
  })

  it("treats internal-slot data mutations as changed", async () => {
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      data: v.object({ url: v.pipe(v.string(), v.transform(value => new URL(value))) }),
      driver: { run },
      intercept: ({ data }) => {
        data.url.pathname = "/changed"
        return undefined
      },
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { url: "https://example.com/original" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it("does not reparse unchanged internal-slot data", async () => {
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({
      data: v.object({ url: v.pipe(v.string(), v.transform(value => new URL(value))) }),
      driver: { run },
      intercept: () => undefined,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { url: "https://example.com/original" } })

    expect(error).toBeNull()
    expect(output).toEqual({ url: new URL("https://example.com/original") })
    expect(run).toHaveBeenCalledOnce()
  })

  it("does not reparse unchanged custom class data", async () => {
    class Count {
      constructor(readonly value: number) {}
    }
    const transform = vi.fn((value: string) => new Count(Number(value)))
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({
      data: v.pipe(v.string(), v.transform(transform)),
      driver: { run },
      hooks: { "agent:input": () => {} },
      intercept: () => undefined,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: "2" })

    expect(error).toBeNull()
    expect(output).toEqual(new Count(2))
    expect(transform).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it("validates data when a Capability replaces the input wrapper in place", async () => {
    const inputHook = vi.fn()
    const intercept = vi.fn(() => undefined)
    const run = vi.fn(() => "ok")
    const replaceInput = defineCapability({
      id: "replace-input",
      input(context) {
        const input = context.input.get()
        input.data = { count: true }
        context.input.set(input)
      },
    })
    const agent = defineAgent({
      capabilities: [replaceInput],
      data: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
      driver: { run },
      hooks: { "agent:input": inputHook },
      intercept,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { count: "2" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(inputHook).not.toHaveBeenCalled()
    expect(intercept).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("skips Capability preparation for intercepted Invocations", async () => {
    const prepare = vi.fn(() => {
      throw new Error("prepare should not run")
    })
    const intercept = vi.fn(() => ({ rule: "github" }))
    const agent = defineAgent({
      capabilities: [{ id: "prepare", prepare }],
      data: v.object({ from: v.string() }),
      driver: { run: () => "driver" },
      intercept,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "a@github.com" } })

    expect(error).toBeNull()
    expect(output).toEqual({ rule: "github" })
    expect(prepare).not.toHaveBeenCalled()
    expect(intercept).toHaveBeenCalledOnce()
  })

  it("preserves Capability phase order after interception falls through", async () => {
    const phases: string[] = []
    let prepared = false
    const capability = defineCapability({
      id: "ordered",
      configure: () => { phases.push("configure") },
      prepare: () => { phases.push("prepare"); prepared = true },
      bind: () => { expect(prepared).toBe(true); phases.push("bind") },
      input: () => { expect(prepared).toBe(true); phases.push("input") },
      resolve: () => { phases.push("resolve") },
      output: () => { phases.push("output") },
      tools: () => { expect(prepared).toBe(true); phases.push("tools"); return {} },
    })
    const agent = defineAgent({
      capabilities: [capability, {
        id: "following",
        configure: () => { expect(prepared).toBe(true); phases.push("following:configure") },
        input: () => { expect(prepared).toBe(true); phases.push("following:input") },
      }],
      driver: { run: () => { phases.push("driver"); return "ok" } },
      intercept: () => undefined,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { prompt: "go" })

    expect(error).toBeNull()
    expect(output).toBe("ok")
    expect(phases).toEqual(["configure", "prepare", "bind", "input", "resolve", "output", "following:configure", "following:input", "tools", "driver"])
  })

  it("skips preparation-dependent phases and tools for intercepted Invocations", async () => {
    const dependent = vi.fn(() => { throw new Error("preparation-dependent phase should not run") })
    const agent = defineAgent({
      capabilities: [{ id: "prepared", prepare: dependent, bind: dependent, input: dependent, resolve: dependent, output: dependent, tools: dependent }],
      driver: { run: dependent },
      intercept: () => "intercepted",
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { prompt: "go" })

    expect(error).toBeNull()
    expect(output).toBe("intercepted")
    expect(dependent).not.toHaveBeenCalled()
  })

  it("skips Capability tool transforms for intercepted Invocations", async () => {
    const transform = vi.fn(() => { throw new Error("tool transform should not run") })
    const agent = defineAgent({
      capabilities: [{
        id: "transform",
        configure(context) {
          context.tools.transform(transform)
        },
      }],
      driver: { run: () => "driver" },
      intercept: () => "intercepted",
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { prompt: "go" })

    expect(error).toBeNull()
    expect(output).toBe("intercepted")
    expect(transform).not.toHaveBeenCalled()
  })

  it("validates data changed by a preparation-dependent input phase before the Driver", async () => {
    const close = vi.fn()
    const run = vi.fn(() => "ok")
    const capability = defineCapability({
      id: "prepared-input",
      prepare() {},
      input(context) { context.input.set({ ...context.input.get(), data: { from: "invalid" } }) },
      close,
    })
    const agent = defineAgent({
      capabilities: [capability],
      data: emailSchema,
      driver: { run },
      intercept: () => undefined,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { from: "friend@example.com", subject: "Dinner" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("does not parse unchanged transformed data again after deferred preparation", async () => {
    const transform = vi.fn((value: string) => Number(value))
    const run = vi.fn(({ input }: { input: { data?: unknown } }) => input.data)
    const agent = defineAgent({
      capabilities: [{ id: "prepared", prepare() {} }],
      data: v.object({ count: v.pipe(v.string(), v.transform(transform)) }),
      driver: { run },
      intercept: () => undefined,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { data: { count: "2" } })

    expect(error).toBeNull()
    expect(output).toEqual({ count: 2 })
    expect(transform).toHaveBeenCalledOnce()
  })

  it("preserves preparation hook ordering after async interception falls through", async () => {
    const phases: string[] = []
    const agent = defineAgent({
      capabilities: [{ id: "hook-prepared", input: () => { phases.push("input") } }],
      driver: { run: () => "ok" },
      hooks: {
        "capability:prepare": () => { phases.push("prepare:before") },
        "capability:prepare:after": () => { phases.push("prepare:after") },
      },
      intercept: async () => { phases.push("intercept"); return undefined },
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { prompt: "go" })

    expect(error).toBeNull()
    expect(output).toBe("ok")
    expect(phases).toEqual(["intercept", "prepare:before", "prepare:after", "input"])
  })

  it("preserves a Response returned by a deferred Capability input phase", async () => {
    const response = new Response("handled")
    const run = vi.fn(() => "driver")
    const close = vi.fn()
    const agent = defineAgent({
      capabilities: [{ id: "prepared-response", prepare() {}, input: () => response, close }],
      driver: { run },
      intercept: () => undefined,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { prompt: "go" })

    expect(error).toBeNull()
    expect(output).toBeInstanceOf(Response)
    if (!(output instanceof Response)) throw new Error("Expected a handled Response")
    expect(await output.text()).toBe("handled")
    expect(run).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("closes resources when deferred preparation fails", async () => {
    const close = vi.fn()
    const run = vi.fn(() => "driver")
    const agent = defineAgent({
      capabilities: [{ id: "failed-preparation", prepare: () => { throw new Error("prepare failed") }, close }],
      driver: { run },
      intercept: () => undefined,
      runtime: false,
    })

    const [error, output] = await runAgent(agent, { prompt: "go" })

    expect(error?.message).toContain("prepare failed")
    expect(output).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("does not report unchanged transformed data as changed", async () => {
    const transform = vi.fn((value: string) => Number(value))
    const capability = defineCapability({
      id: "read-data",
      input(context) {
        expect(context.input.get().data).toEqual({ count: 2 })
      },
    })
    const agent = defineAgent({
      capabilities: [capability],
      data: v.object({ count: v.pipe(v.string(), v.transform(transform)) }),
      driver: { run: () => "ok" },
      runtime: false,
    })

    await runAgentInline(agent, runtime(), { data: { count: "2" } })

    expect(transform).toHaveBeenCalledOnce()
  })

  it("lets a child Agent replace the parent data schema", async () => {
    const child = defineAgent({
      extends: labeller(),
      data: v.object({ from: v.string() }),
    })

    // @ts-expect-error The child schema requires from, not subject.
    const [error] = await runAgent(child, { data: { subject: "Hi" } })
    const [, output] = await runAgent(child, { data: { from: "a@github.com" } })

    expect(error?.message).toContain("Invalid Agent input data")
    expect(output).toEqual({ label: "GitHub", rule: "github" })
  })

  it("records data according to the trace content policy", async () => {
    const data = { from: "friend@example.com", subject: "private subject" }
    const contentRuntime = runtime("content")
    const metadataRuntime = runtime("metadata")

    await runAgentInline(labeller(), contentRuntime, { data })
    await runAgentInline(labeller(), metadataRuntime, { data })

    const contentStart = contentRuntime.traceLog.entries().find(entry => entry.name === "agent.invocation.start")
    const metadataStart = metadataRuntime.traceLog.entries().find(entry => entry.name === "agent.invocation.start")
    expect(contentStart?.attributes).toMatchObject({ "input.data": data, "input.hasData": true })
    expect(metadataStart?.attributes).toMatchObject({ "input.hasData": true })
    expect(JSON.stringify(metadataRuntime.traceLog.entries())).not.toContain("private subject")
  })
})
