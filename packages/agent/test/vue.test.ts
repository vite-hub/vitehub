import { effectScope } from "vue"
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

  it("derives the API from the configured generated chat route", async () => {
    vi.stubGlobal("__VITEHUB_AGENT_CHAT_ROUTE__", "chat/[agent]")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({ execute() {} }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("team/review")))!

    await chat.sendMessage({ text: "Hello" })

    expect(fetch).toHaveBeenCalledWith("/chat/team%2Freview", expect.anything())
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

  it("rejects an implicit API when the generated chat route is disabled", () => {
    vi.stubGlobal("__VITEHUB_AGENT_CHAT_ROUTE__", false)
    const scope = effectScope()

    expect(() => scope.run(() => useChat(useAgent("support")))).toThrow(
      "useChat() requires an Agent chat route. Enable routes.chat or pass api or transport explicitly.",
    )
    expect(() => scope.run(() => useChat(useAgent("support"), { api: "/chat/support" }))).not.toThrow()
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
