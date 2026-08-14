import { useChat as useAiChat } from "@ai-sdk/vue"
import { DefaultChatTransport } from "ai"
import { computed, onScopeDispose, shallowRef, toValue, watch } from "vue"

import { defaultAgentChatRoute, resolveAgentRoutePath } from "./internal/routes.ts"
import { createAgentChatData } from "./messages.ts"

import type { UseChatHelpers } from "@ai-sdk/vue"
import type { ChatInit, HttpChatTransportInitOptions, UIMessage } from "ai"
import type { AgentChatData } from "./messages.ts"
import type { ComputedRef, MaybeRefOrGetter } from "vue"

declare const __VITEHUB_APP_BASE_URL__: string

export interface AgentClient {
  readonly name: string
}

type AgentChatInitBase<UI_MESSAGE extends UIMessage> = Omit<ChatInit<UI_MESSAGE>, "transport">
  & Pick<HttpChatTransportInitOptions<UI_MESSAGE>, "api" | "credentials" | "fetch" | "headers">

export type AgentChatInit<UI_MESSAGE extends UIMessage = UIMessage> = AgentChatInitBase<UI_MESSAGE> & (
  | { resume: true, transport?: never }
  | { resume?: false, transport?: ChatInit<UI_MESSAGE>["transport"] }
)

export type AgentChatReactiveInit<UI_MESSAGE extends UIMessage = UIMessage> = Omit<
  AgentChatInit<UI_MESSAGE>,
  "dataPartSchemas" | "generateId" | "messageMetadataSchema"
> & {
  dataPartSchemas?: never
  generateId?: never
  messageMetadataSchema?: never
}

export interface AgentChatHelpers<UI_MESSAGE extends UIMessage> extends UseChatHelpers<UI_MESSAGE> {
  readonly data: ComputedRef<AgentChatData>
}

export function useAgent(name: string): AgentClient {
  return { name }
}

function agentChatRoute(name: string): string {
  const path = resolveAgentRoutePath(defaultAgentChatRoute, { agent: name })
  const baseURL = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  return baseURL === "/" ? path : `${baseURL.replace(/\/+$/, "")}${path}`
}

export function useChat<UI_MESSAGE extends UIMessage = UIMessage>(
  agent: AgentClient,
  options?: AgentChatInit<UI_MESSAGE>,
): AgentChatHelpers<UI_MESSAGE>
export function useChat<UI_MESSAGE extends UIMessage = UIMessage>(
  agent: AgentClient,
  options: MaybeRefOrGetter<AgentChatReactiveInit<UI_MESSAGE>>,
): AgentChatHelpers<UI_MESSAGE>
export function useChat<UI_MESSAGE extends UIMessage = UIMessage>(
  agent: AgentClient,
  options: AgentChatInit<UI_MESSAGE> | MaybeRefOrGetter<AgentChatReactiveInit<UI_MESSAGE>> = {},
): AgentChatHelpers<UI_MESSAGE> {
  const initialOptions = toValue(options)
  const currentOptions = shallowRef(initialOptions)
  const liveOptions = shallowRef(initialOptions)
  if (currentOptions.value.resume && currentOptions.value.transport) {
    throw new TypeError("[vitehub] Resumable web chat does not support a custom transport because server cancellation cannot be guaranteed.")
  }
  const streamedParts = shallowRef<Array<{ data?: unknown, id?: unknown, transient?: unknown, type?: unknown }>>([])
  watch(() => toValue(options).id, () => {
    currentOptions.value = toValue(options)
    if (currentOptions.value.resume && currentOptions.value.transport) {
      throw new TypeError("[vitehub] Resumable web chat does not support a custom transport because server cancellation cannot be guaranteed.")
    }
    streamedParts.value = []
    if (currentOptions.value.resume && "window" in globalThis) queueMicrotask(reconnect)
  })
  const reconnecting = shallowRef(0)
  let reconnectAbort: AbortController | undefined
  let reconnectGeneration = 0
  let disposed = false
  let prepareReplay: (messageId: string | undefined) => void = () => {}
  const chat = useAiChat<UI_MESSAGE>(() => {
    const { api, credentials, fetch, headers, onData, resume: _resume, transport, ...init } = currentOptions.value
    const route = api ?? agentChatRoute(agent.name)
    const defaultTransport = new DefaultChatTransport<UI_MESSAGE>({
      api: route,
      credentials,
      fetch(input, requestInit) {
        const request = fetch ?? globalThis.fetch
        const controller = requestInit?.method === "GET" ? reconnectAbort : undefined
        return request(input, {
          ...requestInit,
          ...(controller ? { signal: controller.signal } : {}),
        }).catch((error) => {
          if (controller?.signal.aborted) {
            return new Response(null, { status: 204 })
          }
          throw error
        })
      },
      headers,
      prepareReconnectToStreamRequest({ credentials, headers, id }) {
        return {
          api: `${route}${route.includes("?") ? "&" : "?"}id=${encodeURIComponent(id)}`,
          credentials,
          headers,
        }
      },
    })
    const reconnectToStream = defaultTransport.reconnectToStream.bind(defaultTransport)
    defaultTransport.reconnectToStream = async (request) => {
      const generation = ++reconnectGeneration
      reconnectAbort?.abort()
      reconnectAbort = new AbortController()
      const stream = await reconnectToStream(request)
      if (generation !== reconnectGeneration) return null
      if (!stream) return null
      const reader = stream.getReader()
      let first: Awaited<ReturnType<typeof reader.read>>
      try {
        first = await reader.read()
      }
      catch (error) {
        if (generation !== reconnectGeneration) return null
        throw error
      }
      if (generation !== reconnectGeneration) {
        await reader.cancel()
        return null
      }
      if (first.done) return null
      prepareReplay(first.value.type === "start" ? first.value.messageId : undefined)
      return new ReadableStream({
        cancel(reason) {
          return reader.cancel(reason)
        },
        start(controller) {
          controller.enqueue(first.value)
        },
        async pull(controller) {
          const chunk = await reader.read()
          if (chunk.done) controller.close()
          else controller.enqueue(chunk.value)
        },
      })
    }
    return {
      ...init,
      onData(part) {
        if (part.type.startsWith("data-") && (part as { transient?: boolean }).transient === true) {
          streamedParts.value = [
            ...streamedParts.value.filter(streamed => streamed.type !== part.type),
            part,
          ]
        }
        else if (part.type.startsWith("data-")) {
          streamedParts.value = streamedParts.value.filter(streamed => streamed.type !== part.type)
        }
        liveOptions.value.onData?.(part)
      },
      transport: transport ?? defaultTransport,
    }
  })
  prepareReplay = (messageId) => {
    if (!messageId) return
    const messages = chat.messages.value
    const partial = messages.at(-1)
    const replay = { id: messageId, parts: [], role: "assistant" } as unknown as UI_MESSAGE
    chat.messages.value = partial?.role === "assistant" && partial.id === messageId
      ? [...messages.slice(0, -1), replay]
      : [...messages, replay]
  }
  if (currentOptions.value.resume && "window" in globalThis) queueMicrotask(reconnect)
  onScopeDispose(() => {
    disposed = true
    reconnectGeneration++
    reconnectAbort?.abort()
    void chat.stop()
  }, true)

  async function stop(): Promise<void> {
    reconnectAbort?.abort()
    await chat.stop()
    if (!currentOptions.value.resume || currentOptions.value.transport || !("window" in globalThis)) return
    const { api, credentials, fetch: request = globalThis.fetch, headers } = currentOptions.value
    const route = api ?? agentChatRoute(agent.name)
    const response = await request(`${route}${route.includes("?") ? "&" : "?"}id=${encodeURIComponent(chat.id.value)}`, {
      credentials: await resolveTransportOption(credentials) ?? "same-origin",
      headers: await resolveTransportOption(headers),
      method: "DELETE",
    })
    if (!response.ok) throw new Error(`[vitehub] Resumable web chat cancellation failed with ${response.status} ${response.statusText || "Unknown Error"}.`)
  }

  async function reconnect(): Promise<void> {
    if (disposed) return
    reconnecting.value++
    try {
      await chat.resumeStream()
    }
    finally {
      reconnecting.value--
    }
  }

  return {
    ...chat,
    status: computed(() => reconnecting.value > 0 && chat.status.value === "ready" ? "submitted" : chat.status.value),
    stop,
    data: computed(() => createAgentChatData([
      ...chat.messages.value.flatMap(message => message.parts),
      ...streamedParts.value,
    ])),
  }
}

async function resolveTransportOption<T>(value: T | (() => T | PromiseLike<T>) | undefined): Promise<T | undefined> {
  return typeof value === "function" ? await (value as () => T | PromiseLike<T>)() : value
}

export type { UseChatHelpers } from "@ai-sdk/vue"
