import { useChat as useAiChat } from "@ai-sdk/vue"
import { DefaultChatTransport } from "ai"
import { computed, onScopeDispose, shallowRef, toValue, watch } from "vue"

import { defaultAgentChatRoute, resolveAgentRoutePath } from "./internal/routes.ts"
import { updateAgentChatStreamedParts } from "./internal/chat-data.ts"
import { createAgentChatData } from "./messages.ts"

import type { UseChatHelpers } from "@ai-sdk/vue"
import type { ChatInit, UIMessage } from "ai"
import type { AgentChatData } from "./messages.ts"
import type { AgentChatStreamedPart } from "./internal/chat-data.ts"
import type { ComputedRef, MaybeRefOrGetter } from "vue"

declare const __VITEHUB_APP_BASE_URL__: string

export interface AgentClient {
  readonly name: string
}

export type AgentChatInit<UI_MESSAGE extends UIMessage = UIMessage> = ChatInit<UI_MESSAGE> & {
  api?: string
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite replaces this build-time constant, while direct source imports leave it undeclared.
  const baseURL = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  return baseURL === "/" ? path : `${baseURL.replace(/\/+$/, "")}${path}`
}

function isBrowserRuntime(): boolean {
  return "window" in globalThis
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
  const constructorOptions = shallowRef(initialOptions)
  const latestOptions = shallowRef(initialOptions)
  const streamedParts = shallowRef<AgentChatStreamedPart[]>([])
  let resumableMessageId = initialOptions.messages?.at(-1)?.id
  let chat!: UseChatHelpers<UI_MESSAGE>
  const resolveTransport = () => {
    if (latestOptions.value.transport) return latestOptions.value.transport
    const route = latestOptions.value.api ?? agentChatRoute(agent.name)
    return new DefaultChatTransport<UI_MESSAGE>({
      api: route,
      async fetch(input, init) {
        const response = await globalThis.fetch(input, init)
        if (init?.method === "GET") {
          resumableMessageId = response.headers.get("x-vitehub-message-id") || undefined
        }
        return response
      },
      prepareReconnectToStreamRequest({ credentials, headers, id }) {
        return {
          api: `${route}${route.includes("?") ? "&" : "?"}id=${encodeURIComponent(id)}`,
          credentials,
          headers,
        }
      },
    })
  }
  const transport = {
    async reconnectToStream(...args: Parameters<NonNullable<ChatInit<UI_MESSAGE>["transport"]>["reconnectToStream"]>) {
      const ownsReplay = !latestOptions.value.transport
      const stream = await resolveTransport().reconnectToStream(...args)
      if (stream && ownsReplay && chat.messages.value.at(-1)?.role === "assistant") {
        chat.messages.value = chat.messages.value.slice(0, -1)
      }
      return stream
    },
    sendMessages: (...args: Parameters<NonNullable<ChatInit<UI_MESSAGE>["transport"]>["sendMessages"]>) => {
      resumableMessageId = args[0].messageId ?? args[0].messages.at(-1)?.id
      return resolveTransport().sendMessages(...args)
    },
  }
  chat = useAiChat<UI_MESSAGE>(() => {
    const { api: _api, onData: _onData, onError: _onError, onFinish: _onFinish, onToolCall: _onToolCall, resume: _resume, sendAutomaticallyWhen: _sendAutomaticallyWhen, transport: _transport, ...init } = constructorOptions.value
    return {
      ...init,
      onData(part) {
        streamedParts.value = updateAgentChatStreamedParts(streamedParts.value, part)
        latestOptions.value.onData?.(part)
      },
      onError: error => latestOptions.value.onError?.(error),
      onFinish: result => latestOptions.value.onFinish?.(result),
      onToolCall: result => latestOptions.value.onToolCall?.(result),
      sendAutomaticallyWhen: result => latestOptions.value.sendAutomaticallyWhen?.(result) ?? false,
      transport,
    }
  })
  const reconnecting = shallowRef(false)
  watch(() => toValue(options), (next, previous) => {
    const prior = latestOptions.value
    latestOptions.value = next
    if (next.id !== previous.id) {
      constructorOptions.value = next
      streamedParts.value = []
      resumableMessageId = undefined
      if (next.resume && isBrowserRuntime()) queueMicrotask(reconnect)
      return
    }

    const nextMessages = next.messages
    if (nextMessages && nextMessages !== prior.messages) {
      const currentMessages = chat.messages.value
      const mirrored = nextMessages.length === currentMessages.length
        && nextMessages.every((message, index) => message === currentMessages[index])
      if (!mirrored) {
        chat.messages.value = nextMessages
        streamedParts.value = []
      }
    }
  })
  if (initialOptions.resume && isBrowserRuntime()) queueMicrotask(reconnect)
  onScopeDispose(() => {
    void chat.stop()
  }, true)

  async function stop(): Promise<void> {
    await chat.stop()
    if (!latestOptions.value.resume || latestOptions.value.transport || !isBrowserRuntime()) return
    if (!resumableMessageId) return
    const route = latestOptions.value.api ?? agentChatRoute(agent.name)
    await fetch(`${route}${route.includes("?") ? "&" : "?"}id=${encodeURIComponent(chat.id.value)}&messageId=${encodeURIComponent(resumableMessageId)}`, {
      credentials: "same-origin",
      method: "DELETE",
    }).then(() => undefined, () => undefined)
  }

  async function reconnect(): Promise<void> {
    const messages = latestOptions.value.messages ?? chat.messages.value
    if (!messages.length) return
    reconnecting.value = true
    try {
      await chat.resumeStream()
    } finally {
      reconnecting.value = false
    }
  }

  return {
    ...chat,
    status: computed(() => reconnecting.value && chat.status.value === "ready" ? "submitted" : chat.status.value),
    stop,
    data: computed(() => createAgentChatData([
      ...chat.messages.value.flatMap(message => message.parts),
      ...streamedParts.value,
    ])),
  }
}

export type { UseChatHelpers } from "@ai-sdk/vue"
export { useAgentInvocation, useAgentInvocations } from "./invocations-vue.ts"
export type {
  AgentInvocationDetailResult,
  AgentInvocationRequester,
  AgentInvocationRequestOptions,
  UseAgentInvocationOptions,
  UseAgentInvocationReturn,
  UseAgentInvocationsOptions,
  UseAgentInvocationsReturn,
} from "./invocations-vue.ts"
