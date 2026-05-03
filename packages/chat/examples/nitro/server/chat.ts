import { createTelegramAdapter } from "@chat-adapter/telegram"
import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"
import { Chat } from "chat"
import { defineChat } from "@vitehub/chat"

import { answerWithContext } from "./utils/agent"

export default defineChat({
  create(ctx) {
    const runtimeConfig = ctx.runtimeConfig as {
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
    const telegram = runtimeConfig.telegram
    const apiBaseUrl = telegram.apiBaseUrl?.trim()
    const botUsername = telegram.botUsername?.trim()

    const bot = new Chat({
      adapters: {
        telegram: createTelegramAdapter({
          botToken: telegram.botToken,
          secretToken: telegram.webhookSecretToken,
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
          ...(botUsername ? { userName: botUsername } : {}),
        }),
      },
      fallbackStreamingPlaceholderText: "Reading Quiver data sources...",
      state: cloudflareDurableObjectState(ctx, {
        binding: "CHAT_STATE",
        name: "quiver-chat",
      }),
      streamingUpdateIntervalMs: 1_000,
      userName: "Quiver Chat",
    })

    bot.onDirectMessage(async (thread, message) => {
      await thread.startTyping().catch(() => {})
      const result = await answerWithContext(
        message.text,
        runtimeConfig.vertex.apiKey,
        runtimeConfig.vertex.model,
      )
      await thread.post(result.fullStream)
    })

    return bot
  },
})
