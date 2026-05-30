import { chatDevtoolsBridgeRoute } from "../../../src/chat-shared.js"

export interface ChatBridgeRouteInput {
  ancestorOrigin?: string
  pathname?: string
  referrer?: string
  remoteOrigin?: string
}

export function resolveChatBridgeRoute(input: ChatBridgeRouteInput = {}): string {
  if (input.remoteOrigin) {
    return new URL(chatDevtoolsBridgeRoute, input.remoteOrigin).toString()
  }
  if (input.pathname === "/chat" || input.pathname?.startsWith("/chat/")) {
    return `/chat${chatDevtoolsBridgeRoute}`
  }
  if (input.ancestorOrigin) {
    return new URL(chatDevtoolsBridgeRoute, input.ancestorOrigin).toString()
  }
  if (input.referrer) {
    return new URL(chatDevtoolsBridgeRoute, input.referrer).toString()
  }
  return chatDevtoolsBridgeRoute
}
