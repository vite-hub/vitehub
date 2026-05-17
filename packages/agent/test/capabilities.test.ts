import { describe, expect, it, vi } from "vitest"

import { createAgentMessage as createMessage } from "../src/messages.ts"

describe("agent capabilities", () => {
  it("runs capabilities once in array order and mutates adapter context", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []

    const agent = defineAgent({
      adapter: {
        async generate(context) {
          order.push("adapter")
          return { text: context.messages.map(message => message.parts.map(part => part.type === "text" ? part.text : "").join("")).join("") }
        },
        name: "test",
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
      adapter: { generate: async () => ({ text: "ok" }), name: "test" },
      capabilities: [capability, capability],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("Duplicate agent capability")
  })

  it("transcribes audio input before adapter execution", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { voiceInput } = await import("../src/capabilities.ts")
    const transcribe = vi.fn(async () => "voice transcript")
    const agent = defineAgent({
      adapter: {
        async generate(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("") }
        },
        name: "test",
      },
      capabilities: [voiceInput({ transcribe })],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({
        parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
        role: "user",
      })],
    })).resolves.toMatchObject({ text: "voice transcript" })
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "audio/wav" }))
  })

  it("transforms latest user slash commands before adapter execution", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const run = vi.fn(async ({ args }) => `Summarize: ${args}`)
    const agent = defineAgent({
      adapter: {
        async generate(context) {
          return {
            text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n"),
          }
        },
        name: "test",
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
      adapter: {
        async generate(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n") }
        },
        name: "test",
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
      adapter: {
        async generate(context) {
          return { text: String(context.prompt) }
        },
        name: "test",
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
      adapter: {
        async generate(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n") }
        },
        name: "test",
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
      adapter: {
        async generate(context) {
          return {
            raw: context.input,
            text: `${context.prompt} ${JSON.stringify(context.input.context)}`,
          }
        },
        name: "test",
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

  it("rejects invalid input command names", async () => {
    const { inputCommands } = await import("../src/capabilities.ts")
    expect(() => inputCommands({ commands: { Summarize: { run: () => "" } } })).toThrow("lowercase stable identifier")
  })

  it("transforms chat-origin direct messages through agent input commands", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const { createAgentDirectMessageHook } = await import("../src/chat/runtime/agent-chat.ts")
    const agent = defineAgent({
      adapter: {
        async generate(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("\n") }
        },
        name: "test",
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
    expect(edit).toHaveBeenCalledWith("Summarize: last week")
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
      adapter: {
        async generate(context) {
          capturedTools = context.tools as typeof capturedTools
          return { raw: context.tools, text: Object.keys(context.tools || {}).sort().join(",") }
        },
        name: "test",
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
      adapter: {
        async generate(context) {
          capturedTools = context.tools as typeof capturedTools
          return { text: "ok" }
        },
        name: "test",
      },
      capabilities: [
        db({ access: "schema", policy: "allow" }),
      ],
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})

    expect(capturedTools.db_exec!.policy).toBe("allow")
  })
})
