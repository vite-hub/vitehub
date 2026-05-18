import { describe, expect, it, vi } from "vitest"

import { createAgentMessage as createMessage } from "../src/messages.ts"

describe("agent capabilities", () => {
  it("runs capabilities once in array order and mutates adapter context", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []

    const agent = defineAgent({
      async run(context) {
          order.push("adapter")
          return { text: context.messages.map(message => message.parts.map(part => part.type === "text" ? part.text : "").join("")).join("") }
        },
      capabilities: [
        defineCapability({
          id: "first",
          input(context) {
            order.push("first")
            context.input.setMessages([
              createMessage({ role: "user", text: "a" }),
            ])
          },
        }),
        defineCapability({
          id: "second",
          input(context) {
            order.push("second")
            context.input.setMessages([
              ...context.input.messages(),
              createMessage({ role: "user", text: "b" }),
            ])
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({ text: "ab" })
    expect(order).toEqual(["first", "second", "adapter"])
  })

  it("renders explicit capability instruction slots and appends remaining blocks", async () => {
    const { applyCapabilityInstructionSlots } = await import("../src/capabilities.ts")

    expect(applyCapabilityInstructionSlots("Base\n{{ mcp }}", [
      { id: "skills", instructions: "Skills block" },
      { id: "mcp", instructions: "MCP block" },
    ])).toBe("Base\nMCP block\n\nSkills block")
  })

  it("throws on duplicate capability ids", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const capability = defineCapability({ id: "same" })
    const agent = defineAgent({
      async run() { return { text: "ok" } },
      capabilities: [capability, capability],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("Duplicate agent capability")
  })

  it("runs capabilities for custom run agents", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [
        inputCommands({
          commands: {
            summarize: {
              run: async ({ args }) => `Summarize: ${args}`,
            },
          },
        }),
      ],
      async run({ input }) {
        return {
          text: input.messages?.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n"),
        }
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "/summarize last week" })],
    })).resolves.toMatchObject({ text: "Summarize: last week" })
  })

  it("runs output renderers with context and closes capabilities", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []
    const agent = defineAgent({
      async run() {
          order.push("adapter")
          return { text: "base" }
        },
      hooks: {
        "capability:close": () => {
          order.push("close:hook")
        },
        "capability:close:after": () => {
          order.push("close:after")
        },
      },
      capabilities: [
        defineCapability({
          id: "decorate",
          close() {
            order.push("close")
          },
          output(context) {
            context.output.render((result, renderContext) => {
              order.push(`render:${renderContext.capability.id}`)
              return { text: `${(result as { text?: string }).text}:rendered` }
            })
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({ text: "base:rendered" })
    expect(order).toEqual(["adapter", "render:decorate", "close:hook", "close", "close:after"])
  })

  it("closes capabilities in reverse order and cleans up after setup failures", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []
    const agent = defineAgent({
      async run() {
          return { text: "unreachable" }
        },
      capabilities: [
        defineCapability({
          id: "first",
          close() {
            order.push("close:first")
          },
          resolve() {
            order.push("resolve:first")
          },
        }),
        defineCapability({
          id: "second",
          close() {
            order.push("close:second")
          },
          resolve() {
            order.push("resolve:second")
            throw new Error("setup failed")
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("setup failed")
    expect(order).toEqual(["resolve:first", "resolve:second", "close:second", "close:first"])
  })

  it("runs output renderers and close phase for custom run agents", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "customDecorate",
          close() {
            order.push("close")
          },
          output(context) {
            context.output.render((result, renderContext) => {
              order.push(`render:${renderContext.capability.id}`)
              return { text: `${(result as { text?: string }).text}:rendered` }
            })
          },
        }),
      ],
      async run() {
        order.push("run")
        return { text: "base" }
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({ text: "base:rendered" })
    expect(order).toEqual(["run", "render:customDecorate", "close"])
  })

  it("closes stream capabilities after custom stream consumption", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "streamClose",
          close() {
            order.push("close")
          },
        }),
      ],
      run() {
        order.push("run")
        return (async function* () {
          yield "hello"
          order.push("stream:done")
        })()
      },
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})
    expect(order).toEqual(["run"])
    for await (const _event of stream as AsyncIterable<unknown>) {}
    expect(order).toEqual(["run", "stream:done", "close"])
  })

  it("closes response capabilities after custom response consumption", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "responseClose",
          close() {
            order.push("close")
          },
        }),
      ],
      run() {
        order.push("run")
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello"))
            order.push("response:ready")
            controller.close()
          },
        }))
      },
    })

    const response = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})
    expect(order).toEqual(["run", "response:ready"])
    await expect((response as Response).text()).resolves.toBe("hello")
    expect(order).toEqual(["run", "response:ready", "close"])
  })

  it("awaits close errors for response capabilities without bodies", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "responseClose",
          async close() {
            throw new Error("close failed")
          },
        }),
      ],
      run() {
        return new Response(null, { status: 204 })
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("close failed")
  })

  it("applies capability tool transforms for custom run agents", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "tools",
          resolve(context) {
            context.tools.add({ original: { name: "original" } })
            context.tools.transform(tools => ({
              ...(tools || {}),
              transformed: { name: "transformed" },
            }))
          },
        }),
      ],
      async run(context) {
        return { text: Object.keys(context.tools || {}).sort().join(",") }
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({
      text: "original,transformed",
    })
  })

  it("transcribes audio input with custom execution before adapter execution", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { transcribe } = await import("../src/capabilities.ts")
    const execute = vi.fn(async () => "voice transcript")
    const agent = defineAgent({
      async run(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("") }
        },
      capabilities: [transcribe({ execute })],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({
        parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
        role: "user",
      })],
    })).resolves.toMatchObject({ text: "voice transcript" })
    expect(execute).toHaveBeenCalledWith({ audio: expect.objectContaining({ mediaType: "audio/wav" }) })
  })

  it("mirrors AI SDK transcription options for audio input", async () => {
    const { MockTranscriptionModelV3 } = await import("ai/test")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { transcribe } = await import("../src/capabilities.ts")
    const doGenerate = vi.fn(async () => ({
      durationInSeconds: 1,
      language: "en",
      providerMetadata: undefined,
      response: { modelId: "mock-transcribe", timestamp: new Date() },
      segments: [],
      text: "ai sdk transcript",
      warnings: [],
    }))
    const agent = defineAgent({
      async run(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("") }
        },
      capabilities: [
        transcribe({
          headers: { "x-test": "1" },
          model: new MockTranscriptionModelV3({ doGenerate }) as never,
          providerOptions: { mock: { timestampGranularities: ["word"] } },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({
        parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
        role: "user",
      })],
    })).resolves.toMatchObject({ text: "ai sdk transcript" })
    expect(doGenerate).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ "x-test": "1" }),
      providerOptions: { mock: { timestampGranularities: ["word"] } },
    }))
  })

  it("transforms latest user slash commands before adapter execution", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const run = vi.fn(async ({ args }) => `Summarize: ${args}`)
    const agent = defineAgent({
      async run(context) {
          return {
            text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n"),
          }
        },
      capabilities: [
        inputCommands({
          commands: {
            summarize: {
              description: "Summarize the requested context.",
              run,
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [
        createMessage({ role: "user", text: "/summarize old history" }),
        createMessage({ role: "assistant", text: "Previous answer" }),
        createMessage({ role: "user", text: "  /summarize last week  " }),
      ],
    })).resolves.toMatchObject({ text: "/summarize old history\nPrevious answer\nSummarize: last week" })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      args: "last week",
      name: "summarize",
      text: "  /summarize last week  ",
    }))
  })

  it("passes through unknown and non-leading slash messages", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const run = vi.fn(async () => "handled")
    const agent = defineAgent({
      async run(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n") }
        },
      capabilities: [
        inputCommands({
          commands: {
            known: { run },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "/unknown hello" })],
    })).resolves.toMatchObject({ text: "/unknown hello" })
    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "please run /known hello" })],
    })).resolves.toMatchObject({ text: "please run /known hello" })
    expect(run).not.toHaveBeenCalled()
  })

  it("transforms string prompts through input commands", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      async run(context) {
          return { text: String(context.prompt) }
        },
      capabilities: [
        inputCommands({
          commands: {
            summarize: {
              run: async ({ args }) => `Summarize: ${args}`,
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      prompt: "/summarize last week",
    })).resolves.toMatchObject({ text: "Summarize: last week" })
  })

  it("transforms prompt message arrays through input commands", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      async run(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n") }
        },
      capabilities: [
        inputCommands({
          commands: {
            summarize: {
              run: async ({ args }) => `Summarize: ${args}`,
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      prompt: [
        createMessage({ role: "user", text: "/summarize old history" }),
        createMessage({ role: "assistant", text: "Previous answer" }),
        createMessage({ role: "user", text: "/summarize last week" }),
      ],
    })).resolves.toMatchObject({ text: "/summarize old history\nPrevious answer\nSummarize: last week" })
  })

  it("merges input command patches into the current run input", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      async run(context) {
          return {
            raw: context.input,
            text: `${context.prompt} ${JSON.stringify(context.input.context)}`,
          }
        },
      capabilities: [
        inputCommands({
          commands: {
            triage: {
              run: async ({ args, input }) => ({
                context: {
                  command: "triage",
                  original: input.context?.original,
                },
                prompt: `Triage this request:\n${args}`,
              }),
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      context: { original: true },
      messages: [createMessage({ role: "user", text: "/triage broken login" })],
    })).resolves.toMatchObject({
      text: "Triage this request:\nbroken login {\"original\":true,\"command\":\"triage\"}",
    })
  })

  it("clears stale messages when input command patches replace the prompt", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      async run(context) {
          return {
            text: context.messages.length
              ? context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n")
              : String(context.prompt),
          }
        },
      capabilities: [
        inputCommands({
          commands: {
            triage: {
              run: async ({ args }) => ({ prompt: `Triage this request:\n${args}` }),
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "/triage broken login" })],
    })).resolves.toMatchObject({
      text: "Triage this request:\nbroken login",
    })
  })

  it("rejects invalid input command names", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    expect(() => inputCommands({ commands: { Summarize: { run: () => "" } } })).toThrow("lowercase stable identifier")
  })

  it("transforms chat-origin direct messages through agent input commands", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const { createAgentDirectMessageHook } = await import("../src/chat/runtime/agent-chat.ts")
    const agent = defineAgent({
      async run(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n") }
        },
      capabilities: [
        inputCommands({
          commands: {
            summarize: {
              run: async ({ args }) => `Summarize: ${args}`,
            },
          },
        }),
      ],
    })
    const edit = vi.fn()
    const post = vi.fn(async () => ({ edit, id: "placeholder-1" }))
    const hook = createAgentDirectMessageHook(agent, {
      memo: vi.fn(),
      platform: "slack",
      runtime: "nitro",
      runtimeConfig: {},
      waitUntil: vi.fn(),
    }, {
      adapters: {},
      fallbackStreamingPlaceholderText: "Working...",
      history: false,
    })

    await hook({
      channel: { id: "channel-1" },
      message: { author: { isMe: false }, id: "message-1", text: "/summarize last week" },
      thread: { id: "thread-1", post },
    } as never)

    expect(post).toHaveBeenCalledWith("Working...")
    const editValue = edit.mock.calls[0]?.[0]
    expect(typeof editValue === "string" ? editValue : editValue?.text).toBe("Summarize: last week")
  })

  it("resolves workspace for direct workspace agents with chat history", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      name: "support",
      workspace: {},
      async run() {
          return { text: "ok" }
        },
      capabilities: [
        chat({
          adapters: {},
          history: { source: "thread" },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({ text: "ok" })
  })

  it("creates MCP clients from AI SDK MCP config and closes them after the run", async () => {
    const close = vi.fn()
    const execute = vi.fn(async () => "docs result")
    const tools = vi.fn(async () => ({
      search: {
        description: "Search docs.",
        execute,
        name: "search",
      },
    }))
    const client = {
      close,
      serverInfo: { name: "docs", version: "1.0.0" },
      tools,
    }
    const createMCPClient = vi.fn(async () => client)
    vi.doMock("@ai-sdk/mcp", () => ({ createMCPClient }))

    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { mcp } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> | unknown }> = {}
    const agent = defineAgent({
      async run(context) {
          capturedTools = context.tools as typeof capturedTools
          return { text: Object.keys(context.tools || {}).sort().join(",") }
        },
      capabilities: [
        mcp({
          servers: {
            docs: {
              name: "docs-client",
              transport: {
                headers: { authorization: "Bearer secret-token" },
                type: "http",
                url: "https://example.com/mcp",
              },
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({
      text: "mcp_docs_search",
    })
    await expect(capturedTools.mcp_docs_search!.execute({ query: "capabilities" })).resolves.toBe("docs result")
    expect(createMCPClient).toHaveBeenCalledWith(expect.objectContaining({
      name: "docs-client",
      transport: expect.objectContaining({ type: "http", url: "https://example.com/mcp" }),
    }))
    expect(tools).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it("rejects MCP tool name collisions after normalization", async () => {
    const client = {
      close: vi.fn(),
      tools: vi.fn(async () => ({
        "read-file": { name: "read-file" },
        "read_file": { name: "read_file" },
      })),
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { mcp } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      async run() {
          return { text: "unreachable" }
        },
      capabilities: [
        mcp({
          servers: { fs: client as never },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("Duplicate MCP tool name")
    expect(client.close).toHaveBeenCalledOnce()
  })

  it("isolates MCP clients per concurrent agent run", async () => {
    const closed = new Set<number>()
    let nextId = 0
    const createClient = () => {
      const id = nextId++
      return {
        close: vi.fn(async () => {
          closed.add(id)
        }),
        tools: vi.fn(async () => ({
          ping: {
            execute: async () => {
              if (closed.has(id)) throw new Error(`client ${id} closed`)
              return `pong:${id}`
            },
            name: "ping",
          },
        })),
      }
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { mcp } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [
        mcp({
          servers: {
            docs: createClient as never,
          },
        }),
      ],
      async run(context) {
        if (context.input.context?.slow) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        const result = await context.tools?.mcp_docs_ping?.execute?.({})
        return { text: String(result) }
      },
    })

    await expect(Promise.all([
      runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { context: { slow: false } }),
      runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { context: { slow: true } }),
    ])).resolves.toEqual([
      expect.objectContaining({ text: "pong:0" }),
      expect.objectContaining({ text: "pong:1" }),
    ])
  })

  it("injects compact storage capability tools", async () => {
    const kvGet = vi.fn(async () => "value")
    const kvKeys = vi.fn(async () => ["assets/image.png"])
    const kvSet = vi.fn()
    const kvDel = vi.fn()
    const dbExecute = vi.fn()
    const dbRun = vi.fn()
    vi.doMock("@vitehub/kv", () => ({
      kv: {
        del: kvDel,
        get: kvGet,
        keys: kvKeys,
        set: kvSet,
      },
    }))
    vi.doMock("@vitehub/db/drizzle", () => ({
      databases: {
        default: {
          db: {
            execute: dbExecute,
            run: dbRun,
          },
        },
      },
    }))
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { db, kv } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> | unknown, policy?: unknown }> = {}
    const agent = defineAgent({
      async run(context) {
          capturedTools = context.tools as typeof capturedTools
          return { raw: context.tools, text: Object.keys(context.tools || {}).sort().join(",") }
        },
      capabilities: [
        db({ access: "write" }),
        kv({ access: "write" }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({
      text: "db_exec,db_query,db_schema,kv_edit,kv_read",
    })

    await expect(capturedTools.kv_read!.execute({ key: "theme" })).resolves.toBe("value")
    await expect(capturedTools.kv_read!.execute({ prefix: "assets/" })).resolves.toEqual(["assets/image.png"])
    await capturedTools.kv_edit!.execute({ key: "theme", operation: "put", value: "dark" })
    await capturedTools.kv_edit!.execute({ key: "theme", operation: "delete" })
    expect(kvGet).toHaveBeenCalledWith("theme")
    expect(kvKeys).toHaveBeenCalledWith("assets/")
    expect(kvSet).toHaveBeenCalledWith("theme", "dark")
    expect(kvDel).toHaveBeenCalledWith("theme")

    await capturedTools.db_query!.execute({ statement: "with rows as (select 1) select * from rows;" })
    await expect(capturedTools.db_query!.execute({ statement: "with deleted as (delete from users returning *) select * from deleted" })).rejects.toThrow("read-only")
    expect(capturedTools.db_exec!.policy).toBe("require-approval")
    await expect(capturedTools.db_exec!.execute({ rationale: "", statement: "update users set name = 'A'" })).rejects.toThrow("rationale")
    await expect(capturedTools.db_exec!.execute({ rationale: "drop", statement: "/*audit*/DROP TABLE users" })).rejects.toThrow("schema access")
    await capturedTools.db_exec!.execute({ rationale: "Fix stale row", statement: "update users set name = 'A'" })
    expect(dbExecute).toHaveBeenCalledWith("with rows as (select 1) select * from rows")
    expect(dbRun).toHaveBeenCalledWith("update users set name = 'A'")
  })

  it("allows db_exec policy override for trusted local databases", async () => {
    vi.resetModules()
    vi.doMock("@vitehub/db/drizzle", () => ({
      databases: {
        default: {
          db: {
            execute: vi.fn(),
            run: vi.fn(),
          },
        },
      },
    }))
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { db } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { policy?: unknown }> = {}
    const agent = defineAgent({
      async run(context) {
          capturedTools = context.tools as typeof capturedTools
          return { text: "ok" }
        },
      capabilities: [
        db({ access: "schema", policy: "allow" }),
      ],
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})

    expect(capturedTools.db_exec!.policy).toBe("allow")
  })

  it("adds record-oriented memory tools and preloads pinned procedural memory", async () => {
    const records = [{
      content: "Use gh CLI for GitHub operations.",
      createdAt: "2026-05-18T00:00:00.000Z",
      digest: "sha256:test",
      id: "mem_1",
      kind: "procedural" as const,
      pinned: true,
      scope: { agent: "support" },
      status: "active" as const,
      store: "agent",
      title: "GitHub workflow",
      updatedAt: "2026-05-18T00:00:00.000Z",
      version: 1,
    }]
    const adapter = {
      append: vi.fn(async request => ({ action: "created" as const, item: { ...records[0]!, ...request, id: "mem_2" } })),
      delete: vi.fn(async request => ({ deletedId: request.id, ok: true as const, tombstoneId: "mem_del_1" })),
      export: vi.fn(async () => ({ items: records })),
      read: vi.fn(async request => ({ item: records.find(record => record.id === request.id) || null })),
      search: vi.fn(async () => ({ items: [{ createdAt: records[0]!.createdAt, id: "mem_1", kind: "procedural", snippet: records[0]!.content, title: records[0]!.title, updatedAt: records[0]!.updatedAt }] })),
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { memory } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> | unknown, policy?: unknown }> = {}
    const agent = defineAgent({
      async run(context) {
          capturedTools = context.tools as typeof capturedTools
          return { text: Object.keys(context.tools || {}).sort().join(",") }
        },
      capabilities: [
        memory({
          stores: {
            agent: {
              adapter,
              allowKinds: ["procedural", "semantic"],
              read: {
                preload: [{ kind: "procedural", pinned: true }],
              },
              scope: { agent: "support" },
              write: { mode: "tool" },
            },
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({
      text: "memory_delete,memory_read,memory_remember,memory_search",
    })
    expect(adapter.export).toHaveBeenCalled()
    await expect(capturedTools.memory_search!.execute({ query: "github" })).resolves.toMatchObject({ items: [{ id: "mem_1" }] })
    await expect(capturedTools.memory_read!.execute({ id: "mem_1" })).resolves.toMatchObject({ item: { id: "mem_1" } })
    await expect(capturedTools.memory_remember!.execute({ content: "Prefer workspace JSONL.", kind: "semantic" })).resolves.toMatchObject({ item: { id: "mem_2" } })
    await expect(capturedTools.memory_delete!.execute({ id: "mem_1", reason: "obsolete" })).resolves.toMatchObject({ ok: true })
    expect(await (capturedTools.memory_remember!.policy as (context: { input?: unknown }) => unknown)({ input: {} })).toBe("require-approval")
  })

  it("enforces memory write mode and policy for the selected store", async () => {
    const writableRecord = {
      content: "Keep this.",
      createdAt: "2026-05-18T00:00:00.000Z",
      digest: "sha256:test",
      id: "mem_1",
      kind: "semantic" as const,
      scope: { agent: "support" },
      status: "active" as const,
      store: "agent",
      updatedAt: "2026-05-18T00:00:00.000Z",
      version: 1,
    }
    const writable = {
      append: vi.fn(async () => ({ action: "created" as const, item: writableRecord })),
      delete: vi.fn(async request => ({ deletedId: request.id, ok: true as const, tombstoneId: "mem_del_1" })),
      export: vi.fn(async () => ({ items: [] })),
      read: vi.fn(),
      search: vi.fn(),
    }
    const readonly = {
      append: vi.fn(),
      delete: vi.fn(),
      export: vi.fn(async () => ({ items: [] })),
      read: vi.fn(),
      search: vi.fn(),
    }
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { memory } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> | unknown, policy?: (context: { input?: unknown }) => unknown }> = {}
    const agent = defineAgent({
      async run(context) {
          capturedTools = context.tools as typeof capturedTools
          return { text: "ok" }
        },
      capabilities: [
        memory({
          stores: {
            agent: {
              adapter: writable,
              scope: { agent: "support" },
              write: { mode: "tool", policy: "allow" },
            },
            readonly: {
              adapter: readonly,
              scope: { agent: "support" },
              write: { mode: "off", policy: "deny" },
            },
          },
        }),
      ],
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})
    expect(await capturedTools.memory_remember!.policy!({ input: { store: "agent" } })).toBe("allow")
    await expect(Promise.resolve().then(() => capturedTools.memory_remember!.execute({ content: "Keep this.", kind: "semantic", store: "readonly" }))).rejects.toThrow("does not allow writes")
    await expect(Promise.resolve().then(() => capturedTools.memory_delete!.execute({ id: "mem_1", store: "readonly" }))).rejects.toThrow("does not allow writes")
    expect(readonly.append).not.toHaveBeenCalled()
    expect(readonly.delete).not.toHaveBeenCalled()
  })

  it("persists workspace JSONL memory as append-only events", async () => {
    const files = new Map<string, string>()
    const { workspaceJsonlMemoryStore } = await import("../src/capabilities.ts")
    const adapter = await workspaceJsonlMemoryStore({ path: ".vitehub/memory/test.jsonl" }).create({
      workspace: {
        fs: {
          appendFile: async (path: string, content: string) => files.set(path, `${files.get(path) || ""}${content}`),
          mkdir: vi.fn(),
          readFile: async (path: string) => files.get(path) || "",
          writeFile: vi.fn(),
        },
      },
    } as never)

    const created = await adapter.append({
      content: "Memory is scoped durable context.",
      kind: "semantic",
      scope: { agent: "support" },
      store: "agent",
      title: "Memory definition",
    })
    await expect(adapter.search({ query: "scoped", scope: { agent: "support" }, store: "agent" })).resolves.toMatchObject({
      items: [{ id: created.item.id }],
    })
    await adapter.delete({ id: created.item.id, scope: { agent: "support" }, store: "agent" })
    await expect(adapter.read({ id: created.item.id, scope: { agent: "support" }, store: "agent" })).resolves.toEqual({ item: null })
    expect(files.get(".vitehub/memory/test.jsonl")?.trim().split("\n")).toHaveLength(2)
  })
})
