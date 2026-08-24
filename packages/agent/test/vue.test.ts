import { effectScope, nextTick, ref } from "vue"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { array, object, parse, string } from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { updateAgentChatStreamedParts } from "../src/internal/chat-data.ts"
import { useAgent, useChat } from "../src/vue.ts"

import type { ChatTransport, UIMessage } from "ai"

afterEach(() => vi.unstubAllGlobals())

describe("Agent Vue clients", () => {
  it("bounds retained transient chat data by part type", () => {
    const retained = Array.from({ length: 100 }, (_, revision) => revision + 1).reduce<ReturnType<typeof updateAgentChatStreamedParts>>(
      (parts, revision) => updateAgentChatStreamedParts(parts, {
        data: { revision },
        transient: true,
        type: "data-progress-summary",
      }),
      [],
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

  it("clears provisional data through the serialized UI transport", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ data: { title: "Provisional" }, id: "title", transient: true, type: "data-title" })
          writer.write({ data: null, id: "title", type: "data-title" })
        },
      }),
    }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support")))!

    await chat.sendMessage({ text: "Check inventory" })

    expect(chat.status.value).toBe("ready")
    expect(chat.data.value.get("title")).toBeUndefined()
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

  it("reconnects resumable chats through the default route and exposes the pending state", async () => {
    vi.stubGlobal("window", {})
    let finishReconnect!: (response: Response) => void
    const reconnectResponse = new Promise<Response>((resolve) => {
      finishReconnect = resolve
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, request) => {
      if (request?.method === "GET") return await reconnectResponse
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal("fetch", fetch)
    const messages: UIMessage[] = [{ id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" }]
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      api: "/chat/support?source=portal",
      id: "chat-1",
      messages,
      resume: true,
    }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledWith("/chat/support?source=portal&id=chat-1", expect.objectContaining({ method: "GET" }))
    expect(chat.status.value).toBe("submitted")

    finishReconnect(new Response(null, { status: 204 }))
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    scope.stop()
  })

  it("discards a stale replay stream after a reactive chat change", async () => {
    vi.stubGlobal("window", {})
    const responses = new Map<string, (response: Response) => void>()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      return await new Promise<Response>((resolve) => {
        responses.set(String(input), resolve)
      })
    })
    vi.stubGlobal("fetch", fetch)
    const id = ref("chat-a")
    const messages: UIMessage[] = [{ id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" }]
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), () => ({
      id: id.value,
      messages,
      resume: true,
    })))!

    await vi.waitFor(() => expect(responses.has("/api/_vitehub/agents/support/chat?id=chat-a")).toBe(true))
    id.value = "chat-b"
    await nextTick()
    await vi.waitFor(() => expect(responses.has("/api/_vitehub/agents/support/chat?id=chat-b")).toBe(true))
    responses.get("/api/_vitehub/agents/support/chat?id=chat-b")!(new Response(null, {
      headers: { "x-vitehub-message-id": "message-b" },
      status: 204,
    }))
    responses.get("/api/_vitehub/agents/support/chat?id=chat-a")!(createUIMessageStreamResponse({
      headers: { "x-vitehub-message-id": "message-a" },
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ id: "answer", type: "text-start" })
          writer.write({ delta: "Stale answer", id: "answer", type: "text-delta" })
          writer.write({ id: "answer", type: "text-end" })
        },
      }),
    }))
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    expect(chat.messages.value).toEqual(messages)
    await chat.stop()

    expect(fetch).toHaveBeenLastCalledWith("/api/_vitehub/agents/support/chat?id=chat-b&messageId=message-b", {
      credentials: "same-origin",
      method: "DELETE",
    })
    scope.stop()
  })

  it("keeps the current reconnect pending when an older reconnect settles first", async () => {
    vi.stubGlobal("window", {})
    const responses = new Map<string, (response: Response) => void>()
    const fetch = vi.fn<typeof globalThis.fetch>(async input => await new Promise<Response>((resolve) => {
      responses.set(String(input), resolve)
    }))
    vi.stubGlobal("fetch", fetch)
    const id = ref("chat-a")
    const messages: UIMessage[] = [{ id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" }]
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), () => ({
      id: id.value,
      messages,
      resume: true,
    })))!

    await vi.waitFor(() => expect(responses.has("/api/_vitehub/agents/support/chat?id=chat-a")).toBe(true))
    id.value = "chat-b"
    await nextTick()
    await vi.waitFor(() => expect(responses.has("/api/_vitehub/agents/support/chat?id=chat-b")).toBe(true))

    responses.get("/api/_vitehub/agents/support/chat?id=chat-a")!(new Response(null, { status: 204 }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chat.status.value).toBe("submitted")

    responses.get("/api/_vitehub/agents/support/chat?id=chat-b")!(new Response(null, { status: 204 }))
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    scope.stop()
  })

  it.each([
    ["resume disabled", false, [{ id: "user-2", parts: [{ text: "Hi", type: "text" }], role: "user" }]],
    ["empty history", true, []],
  ])("releases pending status after changing to a chat with %s", async (_case, resume, nextMessages) => {
    vi.stubGlobal("window", {})
    let finishReconnect!: (response: Response) => void
    const fetch = vi.fn<typeof globalThis.fetch>(async () => await new Promise<Response>((resolve) => {
      finishReconnect = resolve
    }))
    vi.stubGlobal("fetch", fetch)
    const id = ref("chat-a")
    const messages = ref<UIMessage[]>([
      { id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" },
    ])
    const shouldResume = ref(true)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), () => ({
      id: id.value,
      messages: messages.value,
      resume: shouldResume.value,
    })))!

    await vi.waitFor(() => expect(chat.status.value).toBe("submitted"))
    id.value = "chat-b"
    messages.value = nextMessages as UIMessage[]
    shouldResume.value = resume
    await nextTick()

    expect(chat.status.value).toBe("ready")
    finishReconnect(new Response(null, { status: 204 }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chat.status.value).toBe("ready")
    scope.stop()
  })

  it("discards a pending replay after a fresh send to the same chat", async () => {
    vi.stubGlobal("window", {})
    let finishReconnect!: (response: Response) => void
    const reconnectResponse = new Promise<Response>((resolve) => {
      finishReconnect = resolve
    })
    let submittedMessageId: string | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.method === "GET") return await reconnectResponse
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      const body = parse(object({ messages: array(object({ id: string() })) }), JSON.parse(String(init?.body)))
      submittedMessageId = body.messages.at(-1)?.id
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute({ writer }) {
            writer.write({ id: "fresh", type: "text-start" })
            writer.write({ delta: "Fresh answer", id: "fresh", type: "text-delta" })
            writer.write({ id: "fresh", type: "text-end" })
          },
        }),
      })
    })
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      id: "chat-1",
      messages: [{ id: "user-1", parts: [{ text: "Old question", type: "text" }], role: "user" }],
      resume: true,
    }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/_vitehub/agents/support/chat?id=chat-1",
      expect.objectContaining({ method: "GET" }),
    ))
    await chat.sendMessage({ text: "New question" })
    finishReconnect(createUIMessageStreamResponse({
      headers: { "x-vitehub-message-id": "user-1" },
      stream: createUIMessageStream({
        execute({ writer }) {
          writer.write({ id: "stale", type: "text-start" })
          writer.write({ delta: "Stale answer", id: "stale", type: "text-delta" })
          writer.write({ id: "stale", type: "text-end" })
        },
      }),
    }))
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))

    expect(chat.messages.value.at(-1)).toMatchObject({
      parts: [{ text: "Fresh answer", type: "text" }],
      role: "assistant",
    })
    expect(chat.messages.value).not.toContainEqual(expect.objectContaining({ id: "stale" }))
    await chat.stop()
    expect(fetch).toHaveBeenLastCalledWith(`/api/_vitehub/agents/support/chat?id=chat-1&messageId=${submittedMessageId}`, {
      credentials: "same-origin",
      method: "DELETE",
    })
    scope.stop()
  })

  it("replaces a restored partial assistant message when replaying its stream", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      return createUIMessageStreamResponse({
        headers: { "x-vitehub-message-id": "user-1" },
        stream: createUIMessageStream({
          execute({ writer }) {
            writer.write({ id: "answer", type: "text-start" })
            writer.write({ delta: "Complete answer", id: "answer", type: "text-delta" })
            writer.write({ id: "answer", type: "text-end" })
          },
        }),
      })
    })
    vi.stubGlobal("fetch", fetch)
    const messages: UIMessage[] = [
      { id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" },
      { id: "assistant-1", parts: [{ text: "Partial answer", type: "text" }], role: "assistant" },
    ]
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      id: "chat-1",
      messages,
      resume: true,
    }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(chat.messages.value.at(-1)).toMatchObject({
      parts: [{ text: "Complete answer", type: "text" }],
      role: "assistant",
    }))
    expect(chat.messages.value).toHaveLength(2)
    await chat.stop()
    expect(fetch).toHaveBeenLastCalledWith("/api/_vitehub/agents/support/chat?id=chat-1&messageId=user-1", {
      credentials: "same-origin",
      method: "DELETE",
    })
    scope.stop()
  })

  it("keeps a restored assistant message when no replay stream exists", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    const messages: UIMessage[] = [
      { id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" },
      { id: "assistant-1", parts: [{ text: "Complete answer", type: "text" }], role: "assistant" },
    ]
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      id: "chat-1",
      messages,
      resume: true,
    }))!

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(chat.messages.value).toEqual(messages)
    scope.stop()
  })

  it("keeps resumable reconnect and stop ownership with an explicit transport", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal("fetch", fetch)
    const reconnectToStream = vi.fn(async () => null)
    const transport: ChatTransport<UIMessage> = {
      reconnectToStream,
      sendMessages: async () => new ReadableStream({ start: controller => controller.close() }),
    }
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      id: "chat-1",
      messages: [{ id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" }],
      resume: true,
      transport,
    }))!

    await vi.waitFor(() => expect(reconnectToStream).toHaveBeenCalledOnce())
    await chat.stop()

    expect(fetch).not.toHaveBeenCalled()
    scope.stop()
  })

  it("cancels a resumable server run only through the public stop helper", async () => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const chat = scope.run(() => useChat(useAgent("support"), {
      api: "/chat/support",
      id: "chat-1",
      messages: [{ id: "user-1", parts: [{ text: "Hello", type: "text" }], role: "user" }],
      resume: true,
    }))!

    scope.stop()
    expect(fetch).not.toHaveBeenCalled()

    await chat.stop()
    expect(fetch).toHaveBeenCalledWith("/chat/support?id=chat-1&messageId=user-1", {
      credentials: "same-origin",
      method: "DELETE",
    })
  })

  it.each([
    ["regeneration", "regenerate-message", "assistant-1"],
    ["automatic continuation", "submit-message", "assistant-1"],
  ])("cancels a resumable %s with its submitted message identity", async (_name, trigger, messageId) => {
    vi.stubGlobal("window", {})
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      const body: unknown = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ messageId, trigger })
      return createUIMessageStreamResponse({ stream: createUIMessageStream({ execute() {} }) })
    })
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    // SAFETY: Both branches construct valid assistant UI message parts for the two initiation paths under test.
    const messages = [{
      id: "assistant-1",
      parts: trigger === "submit-message"
        ? [{ input: {}, state: "input-available", toolCallId: "tool-1", type: "tool-weather" }]
        : [{ text: "Hello", type: "text" }],
      role: "assistant",
    }] as UIMessage[]
    const chat = scope.run(() => useChat(useAgent("support"), {
      api: "/chat/support",
      id: "chat-1",
      messages,
      resume: true,
      ...(trigger === "submit-message"
        ? { sendAutomaticallyWhen: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) }
        : {}),
    }))!

    const request = trigger === "regenerate-message" ? chat.regenerate({ messageId }) : undefined
    if (trigger === "submit-message") await chat.addToolOutput({ output: "sunny", tool: "weather", toolCallId: "tool-1" })
    await request
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/chat/support", expect.anything()))
    await vi.waitFor(() => expect(chat.status.value).toBe("ready"))
    await chat.stop()

    expect(fetch).toHaveBeenLastCalledWith(`/chat/support?id=chat-1&messageId=${messageId}`, {
      credentials: "same-origin",
      method: "DELETE",
    })
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

  it.each([false, true])("stops an active stream when its Vue scope is disposed (resume: %s)", async (resume) => {
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
    const chat = scope.run(() => useChat(useAgent("support"), { resume, transport }))!
    const request = chat.sendMessage({ text: "Hello" })
    await vi.waitFor(() => expect(chat.status.value).toBe("submitted"))

    scope.stop()
    await request

    expect(aborted).toBe(true)
    expect(chat.status.value).toBe("ready")
  })
})
