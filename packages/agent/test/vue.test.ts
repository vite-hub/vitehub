import { effectScope, nextTick, ref } from "vue"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"

import { updateAgentChatStreamedParts } from "../src/internal/chat-data.ts"
import { useAgent, useChat } from "../src/vue.ts"

import type { ChatTransport, UIMessage } from "ai"

afterEach(() => vi.unstubAllGlobals())

describe("Agent Vue clients", () => {
  it("bounds retained transient chat data by part type", () => {
    const retained = Array.from({ length: 100 }, (_, revision) => revision + 1).reduce(
      (parts, revision) => updateAgentChatStreamedParts(parts, {
        data: { revision },
        transient: true,
        type: "data-progress-summary",
      }),
      [] as ReturnType<typeof updateAgentChatStreamedParts>,
    )

    expect(retained).toEqual([{
      data: { revision: 100 },
      transient: true,
      type: "data-progress-summary",
    }])
  })

  it("sends Agent chat requests to the generated route and streams reactive messages", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ id: "answer", type: "text-start" })
          writer.write({ delta: "Hello from ViteHub", id: "answer", type: "text-delta" })
          writer.write({ id: "answer", type: "text-end" })
        },
      }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("team/review"), { id: "chat-1" }))!

    await chat.sendMessage({ text: "Hello" })

    expect(fetch).toHaveBeenCalledOnce()
    const [api, request] = fetch.mock.calls[0]!
    expect(api).toBe("/api/_vitehub/agents/team%2Freview/chat")
    expect(JSON.parse(String(request?.body))).toMatchObject({
      id: "chat-1",
      messages: [{ parts: [{ text: "Hello", type: "text" }], role: "user" }],
      trigger: "submit-message",
    })
    expect(chat.status.value).toBe("ready")
    expect(chat.messages.value.at(-1)).toMatchObject({
      parts: [{ text: "Hello from ViteHub", type: "text" }],
      role: "assistant",
    })

    scope.stop()
  })

  it("keeps active chat state and stop ownership across same-id reactive updates", async () => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => createUIMessageStreamResponse({
      stream: createUIMessageStream(String(input) === "/chat/first"
        ? {
            async execute() {
              await finished
            },
          }
        : { execute() {} }),
    }))
    vi.stubGlobal("fetch", fetch)
    const api = ref("/chat/first")
    const messages = ref<UIMessage[]>([])
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), () => ({
      api: api.value,
      id: "chat-1",
      messages: messages.value,
    })))!

    const request = chat.sendMessage({ text: "Hello" })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    messages.value = [...chat.messages.value]
    api.value = "/chat/second"
    await nextTick()

    expect(fetch).toHaveBeenCalledOnce()
    expect(chat.status.value).toBe("submitted")
    expect(chat.messages.value).toHaveLength(1)
    chat.stop()
    finish()
    await request
    expect(chat.status.value).toBe("ready")
    await chat.sendMessage({ text: "Again" })
    expect(fetch).toHaveBeenLastCalledWith("/chat/second", expect.anything())
    scope.stop()
  })

  it("applies same-id reactive configuration and message replacements", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({ execute() {} }),
    }))
    vi.stubGlobal("fetch", fetch)
    const api = ref("/chat/first")
    const messages = ref<UIMessage[]>([])
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), () => ({
      api: api.value,
      id: "chat-1",
      messages: messages.value,
    })))!

    messages.value = [{ id: "replacement", parts: [{ text: "Restored", type: "text" }], role: "user" }]
    api.value = "/chat/second"
    await nextTick()
    expect(chat.messages.value).toEqual(messages.value)

    await chat.sendMessage({ text: "Continue" })
    expect(fetch).toHaveBeenCalledWith("/chat/second", expect.anything())
    scope.stop()
  })

  it("derives reactive data from persistent and transient data parts", async () => {
    const onData = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ data: { title: "Provisional" }, id: "title", transient: true, type: "data-title" })
          writer.write({ data: { revision: 1, summary: "Checking inventory" }, transient: true, type: "data-progress-summary" })
          writer.write({ data: { revision: 2, summary: "Inventory checked" }, transient: true, type: "data-progress-summary" })
          writer.write({ data: { title: "Inventory health" }, id: "title", type: "data-title" })
        },
      }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { onData }))!

    await chat.sendMessage({ text: "Check inventory" })

    expect(chat.data.value.get("title", "title")).toBe("Inventory health")
    expect(chat.data.value.get("progress-summary")).toEqual({ revision: 2, summary: "Inventory checked" })
    expect(chat.data.value.entries()).toHaveLength(2)
    expect(onData).toHaveBeenCalledTimes(4)

    chat.messages.value = []
    expect(chat.data.value.get("title")).toBeUndefined()
    expect(chat.data.value.get("progress-summary")).toEqual({ revision: 2, summary: "Inventory checked" })
    scope.stop()
  })

  it("prefers an explicit transport over the API option", async () => {
    const sendMessages = vi.fn(async () => new ReadableStream({
      start(controller) {
        controller.close()
      },
    }))
    const transport: ChatTransport<UIMessage> = {
      reconnectToStream: async () => null,
      sendMessages,
    }
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      api: "/unused",
      transport,
    }))!

    await chat.sendMessage({ text: "Hello" })

    expect(sendMessages).toHaveBeenCalledOnce()
    scope.stop()
  })

  it("rejects a custom transport for resumable chat", () => {
    vi.stubGlobal("window", {})
    const transport = { reconnectToStream: async () => null, sendMessages: async () => null } as never
    const scope = effectScope()

    expect(() => scope.run(() => useChat(useAgent("support"), { id: "chat-1", resume: true, transport } as never))).toThrow("does not support a custom transport")
    scope.stop()
  })

  it("requires a stable ID and reacts when resume is enabled", async () => {
    vi.stubGlobal("window", {})
    const scope = effectScope()
    expect(() => scope.run(() => useChat(useAgent("support"), { resume: true } as never))).toThrow("requires a stable id")

    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    const options = ref({ id: "chat-1", resume: false })
    const chat = scope.run(() => useChat(useAgent("support"), options))!
    options.value = { id: "chat-1", resume: true }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(chat.status.value).toBe("ready")
    scope.stop()
  })

  it("uses an explicit API instead of the conventional generated route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({ execute() {} }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("team/review"), { api: "/chat/team-review" }))!

    await chat.sendMessage({ text: "Hello" })

    expect(fetch).toHaveBeenCalledWith("/chat/team-review", expect.anything())
    scope.stop()
  })

  it("prefixes the generated chat route with the application base URL", async () => {
    vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/portal/")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({ execute() {} }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support")))!

    await chat.sendMessage({ text: "Hello" })

    expect(fetch).toHaveBeenCalledWith("/portal/api/_vitehub/agents/support/chat", expect.anything())
    scope.stop()
  })

  it("stops an active stream when its Vue scope is disposed", async () => {
    let aborted = false
    const transport: ChatTransport<UIMessage> = {
      reconnectToStream: async () => null,
      sendMessages: async ({ abortSignal }) => new ReadableStream({
        start(controller) {
          abortSignal?.addEventListener("abort", () => {
            aborted = true
            controller.error(new DOMException("Aborted", "AbortError"))
          })
        },
      }),
    }
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { transport }))!
    const request = chat.sendMessage({ text: "Hello" })
    await vi.waitFor(() => expect(chat.status.value).toBe("submitted"))

    scope.stop()
    await request

    expect(aborted).toBe(true)
    expect(chat.status.value).toBe("ready")
  })

  it("reports submitted while a resumed stream reconnects without cancelling on disposal", async () => {
    vi.stubGlobal("window", {})
    let releaseReconnect!: () => void
    const reconnect = new Promise<Response>((resolve) => {
      releaseReconnect = () => resolve(new Response(null, { status: 204 }))
    })
    const fetch = vi.fn<typeof globalThis.fetch>(() => reconnect)
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      id: "chat-1",
      messages: [{ id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" }],
      resume: true,
    }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(chat.status.value).toBe("submitted")
    expect(fetch).toHaveBeenCalledWith("/api/_vitehub/agents/support/chat?id=chat-1", expect.anything())
    releaseReconnect()
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    scope.stop()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("reports submitted while reconnecting after a partial assistant message", async () => {
    vi.stubGlobal("window", {})
    let releaseReconnect!: () => void
    const reconnect = new Promise<Response>((resolve) => {
      releaseReconnect = () => resolve(new Response(null, { status: 204 }))
    })
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(() => reconnect))
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      id: "chat-1",
      messages: [{ id: "assistant-1", parts: [{ text: "Partial", type: "text" }], role: "assistant" }],
      resume: true,
    }))!

    await vi.waitFor(() => expect(chat.status.value).toBe("submitted"))
    releaseReconnect()
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    scope.stop()
  })

  it("replaces persisted partial assistant content with the retained full replay", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ messageId: "assistant-1", type: "start" })
          writer.write({ id: "text-1", type: "text-start" })
          writer.write({ delta: "Partial answer", id: "text-1", type: "text-delta" })
          writer.write({ id: "text-1", type: "text-end" })
          writer.write({ type: "finish" })
        },
      }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      id: "chat-1",
      messages: [{ id: "assistant-1", parts: [{ text: "Partial", type: "text" }], role: "assistant" }],
      resume: true,
    }))!

    await vi.waitFor(() => expect(chat.messages.value[0]?.parts).toContainEqual(expect.objectContaining({ text: "Partial answer", type: "text" })))
    expect(chat.messages.value).toHaveLength(1)
    expect(chat.messages.value[0]?.id).toBe("assistant-1")
    scope.stop()
  })

  it("preserves a previous assistant turn when reconnecting to a newer invocation", async () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ messageId: "assistant-2", type: "start" })
          writer.write({ id: "text-2", type: "text-start" })
          writer.write({ delta: "New answer", id: "text-2", type: "text-delta" })
          writer.write({ id: "text-2", type: "text-end" })
          writer.write({ type: "finish" })
        },
      }),
    })))
    const previous = { id: "assistant-1", parts: [{ text: "Previous answer", type: "text" as const }], role: "assistant" as const }
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { id: "chat-1", messages: [previous], resume: true }))!

    await vi.waitFor(() => expect(chat.messages.value).toHaveLength(2))
    expect(chat.messages.value[0]).toEqual(previous)
    expect(chat.messages.value[1]).toMatchObject({ id: "assistant-2", parts: [{ text: "New answer", type: "text" }] })
    scope.stop()
  })

  it("aborts a pending reconnect on scope disposal without deleting the server run", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { id: "chat-1", resume: true }))!
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    scope.stop()
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET")
  })

  it("does not start a queued reconnect after same-tick scope disposal", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    scope.run(() => useChat(useAgent("support"), { id: "chat-1", resume: true }))

    scope.stop()
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("preserves partial content when a newer reconnect supersedes a pending reconnect", async () => {
    vi.stubGlobal("window", {})
    let releaseReconnect!: () => void
    const reconnect = new Promise<Response>((resolve) => {
      releaseReconnect = () => resolve(new Response(null, { status: 204 }))
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).includes("chat-2")) return reconnect
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      })
    })
    vi.stubGlobal("fetch", fetch)
    const options = ref({
      id: "chat-1",
      messages: [{ id: "assistant-1", parts: [{ text: "First partial", type: "text" as const }], role: "assistant" as const }],
      resume: true,
    })
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), options))!
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    options.value = {
      ...options.value,
      id: "chat-2",
      messages: [{ id: "assistant-2", parts: [{ text: "Second partial", type: "text" as const }], role: "assistant" as const }],
    }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(chat.status.value).toBe("submitted"))
    releaseReconnect()
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    expect(chat.messages.value).toEqual(options.value.messages)
    scope.stop()
  })

  it("ignores a superseded reconnect body abort while the next chat reconnects", async () => {
    vi.stubGlobal("window", {})
    const options = ref({ id: "chat-1", resume: true })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).includes("chat-2")) return new Response(null, { status: 204 })
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"messageId":"assistant-1","type":"start"}\n\n'))
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")))
        },
      }), { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } })
    })
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), options))!
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    options.value = { id: "chat-2", resume: true }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    expect(chat.error.value).toBeUndefined()
    scope.stop()
  })

  it("preserves partial content when the current reconnect fails", async () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => new Response("unavailable", { status: 503 })))
    const messages = [{ id: "assistant-1", parts: [{ text: "Persisted partial", type: "text" as const }], role: "assistant" as const }]
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { id: "chat-1", messages, resume: true }))!

    await vi.waitFor(() => expect(chat.status.value).toBe("error"))
    expect(chat.messages.value).toEqual(messages)
    scope.stop()
  })

  it("sends explicit resumable chat cancellation through DELETE", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      credentials: "include",
      headers: async () => ({ authorization: "Bearer token" }),
      id: "chat-1",
      messages: [{ id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" }],
      resume: true,
    }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await chat.stop()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith("/api/_vitehub/agents/support/chat?id=chat-1", {
      credentials: "include",
      headers: { authorization: "Bearer token" },
      method: "DELETE",
    })
    scope.stop()
  })

  it("keeps cancellation tied to the chat options captured when stop starts", async () => {
    vi.stubGlobal("window", {})
    let releaseHeaders!: () => void
    const headersReady = new Promise<void>((resolve) => {
      releaseHeaders = resolve
    })
    let headerCalls = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    const options = ref({
      api: "/old-chat",
      fetch,
      headers: async () => {
        if (++headerCalls > 1) await headersReady
        return { authorization: "Bearer old" }
      },
      id: "chat-1",
      resume: true as const,
    })
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), options))!
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    const stopping = chat.stop()
    options.value = { ...options.value, api: "/new-chat", id: "chat-2" }
    await nextTick()
    releaseHeaders()
    await stopping

    expect(fetch).toHaveBeenLastCalledWith("/old-chat?id=chat-1", {
      credentials: "same-origin",
      headers: { authorization: "Bearer old" },
      method: "DELETE",
    })
    scope.stop()
  })

  it("rejects explicit resumable chat cancellation when the server does not accept DELETE", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => new Response(null, { status: init?.method === "DELETE" ? 429 : 204 }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { id: "chat-1", resume: true }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await expect(chat.stop()).rejects.toThrow("cancellation failed with 429")
    scope.stop()
  })

  it("rejects explicit resumable chat cancellation when DELETE cannot reach the server", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.method === "DELETE") throw new TypeError("network unavailable")
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { id: "chat-1", resume: true }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await expect(chat.stop()).rejects.toThrow("network unavailable")
    scope.stop()
  })
})
