import { describe, expect, it, vi } from "vitest"

import { channelDelivery, inputCommands } from "../src/capabilities.ts"
import { createAgentInspectionMetadata, defineAgent, defineCapability, resolveAgentInspectionMetadata, runAgent } from "../src/index.ts"

import type { AgentToolSet } from "../src/index.ts"

const schedule = {
  id: "friday-2026-09-25",
  runId: "friday-run",
  scheduledAt: new Date("2026-09-25T15:00:00.000Z"),
}

function createChannel(error?: Error) {
  return {
    name: "teams",
    send: vi.fn(async (_text: string, _options: { recipient: string }) => error
      ? [error, null] as [Error, null]
      : [null, { deliveryId: "delivery-1" }] as [null, { deliveryId: string }]),
  }
}

function agentCalling(calls: (tools: AgentToolSet) => Promise<unknown>) {
  return defineAgent({
    name: "bot",
    runtime: false,
    driver: { async run({ tools }) {
      await calls(tools!)
      return "done"
    } },
  })
}

describe("channelDelivery()", () => {
  it.each([
    ["before", "static"], ["after", "static"],
    ["before", "resolved"], ["after", "resolved"],
    ["before", "dynamic"], ["after", "dynamic"],
  ] as const)("rejects a collision when delivery is %s a %s Capability tool", async (order, registration) => {
    const channel = createChannel()
    const execute = vi.fn()
    const run = vi.fn()
    const delivery = channelDelivery({ channel, name: "email_send", options: { recipient: "user:1" }, required: true })
    const tools = { email_send: { name: "email_send", execute } }
    const other = defineCapability(registration === "dynamic"
      ? { id: "other", resolve: context => context.tools.add(tools) }
      : { id: "other", tools: registration === "resolved" ? () => tools : tools })
    const agent = defineAgent({
      runtime: false,
      driver: { run },
      capabilities: order === "before" ? [delivery, other] : [other, delivery],
    })

    const [error, result] = await runAgent(agent, { prompt: "Write" })
    expect(error).toMatchObject({ code: "CHANNEL_DELIVERY_TOOL_CONFLICT" })
    expect(result).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it.each(["before", "after"] as const)("enforces required delivery %s a handled input command", async (order) => {
    const channel = createChannel()
    const run = vi.fn()
    const delivery = channelDelivery({ channel, options: { recipient: "user:1" }, required: true })
    const commands = inputCommands({ commands: { debug: { call: ({ context }) => context.reply("Handled") } } })
    const agent = defineAgent({
      runtime: false,
      driver: { run },
      capabilities: order === "before" ? [delivery, commands] : [commands, delivery],
    })

    const [error, result] = await runAgent(agent, { prompt: "/debug" })
    expect(error).toMatchObject({ code: "CHANNEL_DELIVERY_REQUIRED", details: { attempts: 0, tool: "send_message" } })
    expect(result).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it("allows a handled input command when delivery is optional", async () => {
    const channel = createChannel()
    const run = vi.fn()
    const agent = defineAgent({
      runtime: false,
      driver: { run },
      capabilities: [
        inputCommands({ commands: { debug: { call: ({ context }) => context.reply("Handled") } } }),
        channelDelivery({ channel, options: { recipient: "user:1" } }),
      ],
    })

    const [error, result] = await runAgent(agent, { prompt: "/debug" })
    expect(error).toBeNull()
    expect(result).toBeInstanceOf(Response)
    expect(result).toMatchObject({ status: 204 })
    expect(run).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it.each([
    ["before", "toString"], ["after", "toString"],
    ["before", "constructor"], ["after", "constructor"],
  ] as const)("allows delivery %s an ordinary tool with the name %s", async (order, name) => {
    const channel = createChannel()
    const delivery = channelDelivery({ channel, name, options: { recipient: "user:1" }, required: true })
    const other = defineCapability({ id: "other", resolve: context => context.tools.add({ ordinary: { name: "ordinary", execute: () => "done" } }) })
    const agent = defineAgent({
      extends: agentCalling(async tools => {
        await tools[name]!.execute!({ message: "Hello" })
      }),
      capabilities: order === "before" ? [delivery, other] : [other, delivery],
    })

    await expect(runAgent(agent, { prompt: "Write" })).resolves.toEqual([null, "done"])
    expect(channel.send).toHaveBeenCalledWith("Hello", { recipient: "user:1" })
  })

  it("sends through the Channel to the configured recipient once", async () => {
    const channel = createChannel()
    const base = agentCalling(async (tools) => {
      await expect(tools.send_message!.execute!({ message: "  Roast  " })).resolves.toEqual({ deliveryId: "delivery-1", sent: true })
      await expect(tools.send_message!.execute!({ message: "Again" })).rejects.toMatchObject({ code: "CHANNEL_DELIVERY_LIMIT" })
    })
    const agent = defineAgent({
      extends: base,
      name: "friday",
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true })],
    })

    await expect(runAgent(agent, { prompt: "Write" })).resolves.toEqual([null, "done"])
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledWith("Roast", { recipient: "user:1" })
  })

  it("fails a required delivery that the Agent never sent", async () => {
    const channel = createChannel()
    const agent = defineAgent({
      extends: agentCalling(async () => {}),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true })],
    })

    const [error, result] = await runAgent(agent, { prompt: "Write" })
    expect(result).toBeNull()
    expect(error).toMatchObject({ code: "CHANNEL_DELIVERY_REQUIRED", message: "[vitehub] The Agent finished without a successful send_message call." })
    expect(channel.send).not.toHaveBeenCalled()
  })

  it("keeps rejected messages retryable and fails a required delivery after a send error", async () => {
    const channel = createChannel(new Error("Teams is down"))
    const validate = vi.fn((message: string) => {
      if (message.split(/\s+/u).length > 3) throw new Error("At most 3 words")
    })
    const agent = defineAgent({
      extends: agentCalling(async (tools) => {
        await expect(tools.send_message!.execute!({ message: "one two three four" })).rejects.toThrow("At most 3 words")
        await expect(tools.send_message!.execute!({ message: "one two three" })).rejects.toThrow("Teams is down")
        await expect(tools.send_message!.execute!({ message: "Retry" })).rejects.toMatchObject({ code: "CHANNEL_DELIVERY_LIMIT" })
      }),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true, validate })],
    })

    const [error] = await runAgent(agent, { prompt: "Write" })
    expect(error).toMatchObject({ code: "CHANNEL_DELIVERY_REQUIRED" })
    expect(validate).toHaveBeenCalledTimes(2)
    expect(channel.send).toHaveBeenCalledTimes(1)
  })

  it("keeps formatter failures retryable", async () => {
    const channel = createChannel()
    const format = vi.fn().mockRejectedValueOnce(new Error("Format failed")).mockResolvedValueOnce("Formatted")
    const agent = defineAgent({
      extends: agentCalling(async (tools) => {
        await expect(tools.send_message!.execute!({ message: "First" })).rejects.toThrow("Format failed")
        expect(channel.send).not.toHaveBeenCalled()
        await expect(tools.send_message!.execute!({ message: "Retry" })).resolves.toEqual({ deliveryId: "delivery-1", sent: true })
      }),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true, format })],
    })

    await expect(runAgent(agent, { prompt: "Write" })).resolves.toEqual([null, "done"])
    expect(channel.send).toHaveBeenCalledExactlyOnceWith("Formatted", { recipient: "user:1" })
  })

  it("does not consume an attempt when formatting produces empty text", async () => {
    const channel = createChannel()
    const format = vi.fn().mockReturnValueOnce("   ").mockReturnValueOnce("Formatted")
    const agent = defineAgent({
      extends: agentCalling(async (tools) => {
        await expect(tools.send_message!.execute!({ message: "First" })).rejects.toThrow("formatted text to be non-empty")
        await expect(tools.send_message!.execute!({ message: "Retry" })).resolves.toEqual({ deliveryId: "delivery-1", sent: true })
      }),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, format })],
    })

    await expect(runAgent(agent, { prompt: "Write" })).resolves.toEqual([null, "done"])
    expect(channel.send).toHaveBeenCalledExactlyOnceWith("Formatted", { recipient: "user:1" })
  })

  it("exposes the delivery tool in workspace inspection metadata", () => {
    const agent = defineAgent({
      workspace: { sources: {} },
      driver: { model: {} as never },
      capabilities: [channelDelivery({ channel: createChannel(), options: { recipient: "user:1" } })],
    })

    expect(createAgentInspectionMetadata(agent).tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "send_message", category: "capability" }),
    ]))
  })

  it("exposes a custom delivery tool in resolved inspection without executing callbacks", async () => {
    const channel = createChannel()
    const format = vi.fn()
    const validate = vi.fn()
    const agent = defineAgent({
      extends: agentCalling(async () => {}),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, name: "send_report", format, validate })],
    })

    expect((await resolveAgentInspectionMetadata(agent)).tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "send_report", category: "capability" }),
    ]))
    expect(channel.send).not.toHaveBeenCalled()
    expect(format).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })

  it.each([false, true])("skips callbacks after exhausting attempts when the send fails %s", async (fails) => {
    const channel = createChannel(fails ? new Error("Send failed") : undefined)
    const validate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("Validation must not run"))
    const format = vi.fn().mockResolvedValueOnce("Formatted").mockRejectedValue(new Error("Formatting must not run"))
    const agent = defineAgent({
      extends: agentCalling(async (tools) => {
        const first = tools.send_message!.execute!({ message: "First" })
        if (fails) await expect(first).rejects.toThrow("Send failed")
        else await expect(first).resolves.toMatchObject({ sent: true })
        await expect(tools.send_message!.execute!({ message: "Retry" })).rejects.toMatchObject({ code: "CHANNEL_DELIVERY_LIMIT" })
      }),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, validate, format })],
    })

    await expect(runAgent(agent, { prompt: "Write" })).resolves.toEqual([null, "done"])
    expect(validate).toHaveBeenCalledTimes(1)
    expect(format).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledTimes(1)
  })

  it("limits concurrent calls after asynchronous formatting", async () => {
    const channel = createChannel()
    const agent = defineAgent({
      extends: agentCalling(async (tools) => {
        const results = await Promise.allSettled([
          tools.send_message!.execute!({ message: "First" }),
          tools.send_message!.execute!({ message: "Second" }),
        ])
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
        expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CHANNEL_DELIVERY_LIMIT" } })
      }),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true, format: async message => message })],
    })

    await expect(runAgent(agent, { prompt: "Write" })).resolves.toEqual([null, "done"])
    expect(channel.send).toHaveBeenCalledTimes(1)
  })

  it("preserves the original invocation error when delivery is required", async () => {
    const channel = createChannel()
    const agent = defineAgent({
      extends: agentCalling(async () => { throw new Error("Driver failed") }),
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true })],
    })

    const [error] = await runAgent(agent, { prompt: "Write" })
    expect(error).toMatchObject({ message: "Driver failed" })
    expect(channel.send).not.toHaveBeenCalled()
  })

  it.each([true, false])("checks required delivery when a Response completes and the Agent sends %s", async (sends) => {
    const channel = createChannel()
    const agent = defineAgent({
      runtime: false,
      driver: { run: ({ tools }) => new Response(new ReadableStream({
        async start(controller) {
          if (sends) await tools?.send_message?.execute?.({ message: "Roast" })
          controller.enqueue(new TextEncoder().encode("done"))
          controller.close()
        },
      })) },
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true })],
    })

    const [error, result] = await runAgent(agent, { prompt: "Write" })
    expect(error).toBeNull()
    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new Error("Expected Response")
    if (sends) await expect(result.text()).resolves.toBe("done")
    else await expect(result.text()).rejects.toMatchObject({ code: "CHANNEL_DELIVERY_REQUIRED" })
  })

  it.each(["response", "stream"] as const)("does not require delivery after cancelling a %s", async (output) => {
    const channel = createChannel()
    const finish = vi.fn()
    const agent = defineAgent({
      runtime: false,
      driver: { run: () => output === "response"
        ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")) } }))
        : (async function* () { yield { text: "partial", type: "text-delta" } })() },
      hooks: { "agent:finish": finish },
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true })],
    })

    const [error, result] = await runAgent(agent, { prompt: "Write" })
    expect(error).toBeNull()
    if (result instanceof Response) {
      await expect(result.body!.cancel()).resolves.toBeUndefined()
    }
    else {
      if (!result || typeof result !== "object" || !(Symbol.asyncIterator in result)) throw new Error("Expected stream")
      const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      await iterator.next()
      await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    }
    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0]).toMatchObject({ invocation: { cancelled: true } })
    expect(channel.send).not.toHaveBeenCalled()
  })

  it("formats the message with the invocation context", async () => {
    const channel = createChannel()
    const agent = defineAgent({
      extends: agentCalling(async tools => await tools.review!.execute!({ message: "Suggested reply" })),
      capabilities: [channelDelivery({
        channel,
        options: { recipient: "user:1" },
        name: "review",
        maxCalls: 2,
        format: (message, context) => `${String(context.invocation.input.get().context?.thread)}: ${message}`,
      })],
    })

    await expect(runAgent(agent, { prompt: "Write", context: { thread: "thread-1" } })).resolves.toEqual([null, "done"])
    expect(channel.send).toHaveBeenCalledWith("thread-1: Suggested reply", { recipient: "user:1" })
  })

  it("runs inline next to invocation tools and counts calls per invocation", async () => {
    const channel = createChannel()
    const agent = defineAgent({
      extends: defineAgent({
        name: "bot",
        driver: { async run({ tools }) {
          expect(await tools?.github_api_get?.execute?.({ path: "/repos" })).toEqual({ data: [] })
          await tools?.send_message?.execute?.({ message: "Roast" })
          return "done"
        } },
      }),
      name: "friday-progress-roast",
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true })],
    })
    const options = {
      output: "drained" as const,
      schedule,
      tools: { github_api_get: { name: "github_api_get", execute: vi.fn(async () => ({ data: [] })) } },
    }

    await expect(runAgent(agent, { prompt: "Write" }, options)).resolves.toEqual([null, "done"])
    await expect(runAgent(agent, { prompt: "Write" }, options)).resolves.toEqual([null, "done"])
    expect(channel.send).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])("checks a required delivery after a drained stream when the Agent sends %s", async (sends) => {
    const channel = createChannel()
    const agent = defineAgent({
      runtime: false,
      driver: { run: ({ tools }) => (async function* () {
        if (sends) await tools?.send_message?.execute?.({ message: "Roast" })
        yield { text: "done", type: "text-delta" }
        yield { type: "finish" }
      })() },
      capabilities: [channelDelivery({ channel, options: { recipient: "user:1" }, required: true })],
    })

    const [error, result] = await runAgent(agent, { prompt: "Write" }, { output: "drained" })
    if (sends) {
      expect(error).toBeNull()
      expect(result).toBe("done")
    }
    else {
      expect(error).toMatchObject({ code: "CHANNEL_DELIVERY_REQUIRED" })
    }
  })

  it("rejects invalid options", () => {
    const channel = createChannel()
    expect(() => channelDelivery({ channel, options: { recipient: "user:1" }, maxCalls: 0 })).toThrow(/maxCalls/)
    expect(() => channelDelivery({ channel: {} as never, options: {} })).toThrow(/Channel client/)
  })
})
