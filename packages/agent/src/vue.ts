import { useChat as useAiChat } from "@ai-sdk/vue"
import { DefaultChatTransport } from "ai"
import { onScopeDispose } from "vue"

import { defaultAgentChatRoute, resolveAgentRoutePath } from "./internal/routes.ts"

import type { UseChatHelpers } from "@ai-sdk/vue"
import type { ChatInit, UIMessage } from "ai"

declare const __VITEHUB_AGENT_CHAT_ROUTE__: string | false
declare const __VITEHUB_APP_BASE_URL__: string

export interface AgentClient {
  readonly name: string
}

export type AgentChatInit<UI_MESSAGE extends UIMessage = UIMessage> = ChatInit<UI_MESSAGE> & {
  api?: string
}

export function useAgent(name: string): AgentClient {
  return { name }
}

function agentChatRoute(name: string): string {
  const route = typeof __VITEHUB_AGENT_CHAT_ROUTE__ === "undefined"
    ? defaultAgentChatRoute
    : __VITEHUB_AGENT_CHAT_ROUTE__
  if (route === false) {
    throw new TypeError("[vitehub] useChat() requires an Agent chat route. Enable routes.chat or pass api or transport explicitly.")
  }
  const path = resolveAgentRoutePath(route, { agent: name })
  const baseURL = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  return baseURL === "/" ? path : `${baseURL.replace(/\/+$/, "")}${path}`
}

export function useChat<UI_MESSAGE extends UIMessage = UIMessage>(
  agent: AgentClient,
  options: AgentChatInit<UI_MESSAGE> = {},
): UseChatHelpers<UI_MESSAGE> {
  const { api, transport, ...init } = options
  const chat = useAiChat<UI_MESSAGE>({
    ...init,
    transport: transport ?? new DefaultChatTransport<UI_MESSAGE>({
      api: api ?? agentChatRoute(agent.name),
    }),
  })
  onScopeDispose(chat.stop, true)
  return chat
}

export type { UseChatHelpers } from "@ai-sdk/vue"
