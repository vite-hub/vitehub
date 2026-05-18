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

  it("injects compact storage capability tools", async () => {
    const kvGet = vi.fn(async () => "value")
    const kvKeys = vi.fn(async () => ["assets/image.png"])
    const kvSet = vi.fn()
    const kvDel = vi.fn()
    const blobPut = vi.fn()
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
    vi.doMock("@vitehub/blob", () => ({
      blob: {
        del: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        list: vi.fn(),
        put: blobPut,
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
    const { blob, db, kv } = await import("../src/capabilities.ts")
    let capturedTools: Record<string, { execute: (input: unknown) => Promise<unknown> | unknown, policy?: unknown }> = {}
    const agent = defineAgent({
      async run(context) {
          capturedTools = context.tools as typeof capturedTools
          return { raw: context.tools, text: Object.keys(context.tools || {}).sort().join(",") }
        },
      capabilities: [
        db({ access: "write" }),
        kv({ access: "write" }),
        blob({ access: "write" }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({
      text: "blob_edit,blob_read,db_exec,db_query,db_schema,kv_edit,kv_read",
    })

    await expect(capturedTools.kv_read!.execute({ key: "theme" })).resolves.toBe("value")
    await expect(capturedTools.kv_read!.execute({ prefix: "assets/" })).resolves.toEqual(["assets/image.png"])
    await capturedTools.kv_edit!.execute({ key: "theme", operation: "put", value: "dark" })
    await capturedTools.kv_edit!.execute({ key: "theme", operation: "delete" })
    expect(kvGet).toHaveBeenCalledWith("theme")
    expect(kvKeys).toHaveBeenCalledWith("assets/")
    expect(kvSet).toHaveBeenCalledWith("theme", "dark")
    expect(kvDel).toHaveBeenCalledWith("theme")

    await capturedTools.blob_edit!.execute({ content: "AA==", format: "base64", mediaType: "image/png", operation: "write", pathname: "images/a.png" })
    expect(blobPut).toHaveBeenCalledWith("images/a.png", expect.any(Blob), { contentType: "image/png" })

    await capturedTools.db_query!.execute({ statement: "with rows as (select 1) select * from rows;" })
    await expect(capturedTools.db_query!.execute({ statement: "with deleted as (delete from users returning *) select * from deleted" })).rejects.toThrow("read-only")
    expect(capturedTools.db_exec!.policy).toBe("require-approval")
    await expect(capturedTools.db_exec!.execute({ rationale: "", statement: "update users set name = 'A'" })).rejects.toThrow("rationale")
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
})
