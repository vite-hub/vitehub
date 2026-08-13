import { useChat as useAiChat } from "@ai-sdk/vue"
import { DefaultChatTransport } from "ai"
import { computed, onScopeDispose, shallowRef, toValue, watch } from "vue"

import { defaultAgentChatRoute, resolveAgentRoutePath } from "./internal/routes.ts"
import { createAgentChatData } from "./messages.ts"

import type { UseChatHelpers } from "@ai-sdk/vue"
import type { ChatInit, UIMessage } from "ai"
import type { AgentChatData } from "./messages.ts"
import type { ComputedRef, MaybeRefOrGetter } from "vue"

declare const __VITEHUB_APP_BASE_URL__: string

export interface AgentClient {
  readonly name: string
}

export type AgentChatInit<UI_MESSAGE extends UIMessage = UIMessage> = ChatInit<UI_MESSAGE> & {
  api?: string
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
  options: MaybeRefOrGetter<AgentChatInit<UI_MESSAGE>> = {},
): AgentChatHelpers<UI_MESSAGE> {
  const streamedParts = shallowRef<Array<{ data?: unknown, id?: unknown, transient?: unknown, type?: unknown }>>([])
  watch(() => toValue(options).id, () => {
    streamedParts.value = []
  })
  const chat = useAiChat<UI_MESSAGE>(() => {
    const { api, onData, transport, ...init } = toValue(options)
    return {
      ...init,
      onData(part) {
        if (part.type.startsWith("data-")) streamedParts.value = [...streamedParts.value, part]
        onData?.(part)
      },
      transport: transport ?? new DefaultChatTransport<UI_MESSAGE>({
        api: api ?? agentChatRoute(agent.name),
      }),
    }
  })
  onScopeDispose(chat.stop, true)
  return {
    ...chat,
    data: computed(() => createAgentChatData([
      ...chat.messages.value.flatMap(message => message.parts),
      ...streamedParts.value,
    ])),
  }
}

export type { UseChatHelpers } from "@ai-sdk/vue"
