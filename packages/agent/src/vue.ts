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

export type AgentChatInit<UI_MESSAGE extends UIMessage = UIMessage> = ChatInit<UI_MESSAGE>
  & Pick<HttpChatTransportInitOptions<UI_MESSAGE>, "api" | "credentials" | "fetch" | "headers">
  & {
  resume?: boolean
}

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
  const streamedParts = shallowRef<Array<{ data?: unknown, id?: unknown, transient?: unknown, type?: unknown }>>([])
  watch(() => toValue(options).id, () => {
    currentOptions.value = toValue(options)
    streamedParts.value = []
    if (currentOptions.value.resume && "window" in globalThis) queueMicrotask(reconnect)
  })
  const reconnecting = shallowRef(0)
  let reconnectAbort: AbortController | undefined
  let reconnectGeneration = 0
  let prepareReplay: () => UI_MESSAGE | undefined = () => undefined
  let replayPartial: { chatId: string, message: UI_MESSAGE } | undefined
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
      const partial = prepareReplay()
      if (partial && replayPartial?.chatId !== request.chatId) replayPartial = { chatId: request.chatId, message: partial }
      let stream: Awaited<ReturnType<typeof reconnectToStream>>
      try {
        stream = await reconnectToStream(request)
      }
      catch (error) {
        if (generation === reconnectGeneration && replayPartial?.chatId === request.chatId) {
          chat.messages.value = [...chat.messages.value, replayPartial.message]
          replayPartial = undefined
        }
        throw error
      }
      if (generation !== reconnectGeneration) return null
      if (!stream && replayPartial?.chatId === request.chatId) chat.messages.value = [...chat.messages.value, replayPartial.message]
      replayPartial = undefined
      return stream
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
  prepareReplay = () => {
    const partial = chat.messages.value.at(-1)
    if (partial?.role === "assistant") {
      chat.messages.value = chat.messages.value.slice(0, -1)
      return partial
    }
  }
  if (currentOptions.value.resume && "window" in globalThis) queueMicrotask(reconnect)
  onScopeDispose(() => {
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
    await request(`${route}${route.includes("?") ? "&" : "?"}id=${encodeURIComponent(chat.id.value)}`, {
      credentials: await resolveTransportOption(credentials) ?? "same-origin",
      headers: await resolveTransportOption(headers),
      method: "DELETE",
    }).catch(() => undefined)
  }

  async function reconnect(): Promise<void> {
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
