import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vitehub/messages"

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
})
