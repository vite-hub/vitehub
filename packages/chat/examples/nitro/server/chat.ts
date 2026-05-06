import { createTelegramAdapter } from "@chat-adapter/telegram"
import { defineChat } from "@vitehub/chat"
import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"

import { answerWithContext } from "./utils/agent"

interface ChatRuntimeConfig {
  telegram: {
    apiBaseUrl?: string
    botToken: string
    botUsername?: string
    webhookSecretToken: string
  }
  vertex: {
    apiKey: string
    model: string
  }
}

export default defineChat<ChatRuntimeConfig>({
  adapters({ runtimeConfig }) {
    const telegram = runtimeConfig?.telegram
    if (!telegram?.botToken || !telegram.webhookSecretToken) {
      return {}
    }

    const apiBaseUrl = telegram.apiBaseUrl?.trim()
    const botUsername = telegram.botUsername?.trim()

    return {
      telegram: createTelegramAdapter({
        botToken: telegram.botToken,
        secretToken: telegram.webhookSecretToken,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(botUsername ? { userName: botUsername } : {}),
      }),
    }
  },
  fallbackStreamingPlaceholderText: "Reading Quiver data sources...",
  hooks: {
    async onDirectMessage({ message, runtimeConfig, thread }) {
      await thread.startTyping().catch(() => {})
      const vertex = runtimeConfig?.vertex
      const result = await answerWithContext(
        message.text,
        vertex?.apiKey || "devtools",
        vertex?.model || "dummy",
      )
      await thread.post(result.fullStream)
    },
  },
  state: cloudflareDurableObjectState({
    name: "quiver-chat",
  }),
  streamingUpdateIntervalMs: 1_000,
})
