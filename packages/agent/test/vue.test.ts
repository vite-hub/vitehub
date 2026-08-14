import { effectScope, nextTick, ref } from "vue"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useAgent, useChat } from "../src/vue.ts"

import type { ChatTransport, UIMessage } from "ai"

afterEach(() => vi.unstubAllGlobals())

describe("Agent Vue clients", () => {
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

  it("keeps a reactive external message list stable while sending", async () => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({
        async execute() {
          await finished
        },
      }),
    }))
    vi.stubGlobal("fetch", fetch)
    const messages = ref<UIMessage[]>([])
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), () => ({
      id: "chat-1",
      messages: messages.value,
    })))!

    const request = chat.sendMessage({ text: "Hello" })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    messages.value = [...chat.messages.value]
    await nextTick()

    expect(fetch).toHaveBeenCalledOnce()
    expect(chat.status.value).toBe("submitted")
    finish()
    await request
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
          writer.write({ data: { title: "Provisional" }, id: "title", type: "data-title" })
          writer.write({ data: { summary: "Checking inventory" }, transient: true, type: "data-progress-summary" })
          writer.write({ data: { title: "Inventory health" }, id: "title", type: "data-title" })
        },
      }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), { onData }))!

    await chat.sendMessage({ text: "Check inventory" })

    expect(chat.data.value.get("title", "title")).toBe("Inventory health")
    expect(chat.data.value.get("progress-summary")).toEqual({ summary: "Checking inventory" })
    expect(onData).toHaveBeenCalledTimes(3)

    chat.messages.value = []
    expect(chat.data.value.get("title")).toBeUndefined()
    expect(chat.data.value.get("progress-summary")).toEqual({ summary: "Checking inventory" })
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
})
