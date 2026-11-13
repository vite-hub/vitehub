import { createOpenAI } from "@ai-sdk/openai"
import { createTelegramAdapter } from "@chat-adapter/telegram"
import { defineAgent } from "@vite-hub/agent"
import { mcp, rateLimit, transcribe } from "@vite-hub/agent/capabilities"
import { telegram } from "@vite-hub/agent/channels"
import { remoteMcpServer } from "@vite-hub/agent/mcp"
import { createRateLimiter } from "@vite-hub/rate-limit"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"
import { fetch as fetchSource } from "@vite-hub/workspace"
import { useServerEnv } from "#vitehub/env/server"
import { formatUsageMessage } from "./usage"

export default defineAgent({
  hooks: {
    async "agent:finish"(event) {
      const usage = event.invocation.usage
      if (usage) return event.reply(await formatUsageMessage(usage))
    },
  },
  workspace: {
    sources: {
      nuxt: fetchSource({
        responseType: "text",
        url: new URL("https://nuxt.com/llms.txt"),
        workspacePath: "nuxt/llms.txt",
      }),
    },
  },
  messages: {
    concurrency: "queue",
    userName: "nuxt-agent",
  },
  channels: {
    telegram: telegram({
      adapter: () => {
        const { telegram } = useServerEnv()
        return createTelegramAdapter({
          botToken: telegram.botToken.unseal(),
          secretToken: telegram.webhookSecretToken.unseal(),
        })
      },
      webhooks: { secretToken: () => useServerEnv().telegram.webhookSecretToken.unseal() },
    }),
  },
  driver: { kind: "codex", model: "gpt-5.6-terra" },
  capabilities: [
    rateLimit({
      limiter: createRateLimiter({
        driver: memoryRateLimitDriver(),
        limit: 20,
        name: "nuxt-agent-messages",
        window: "1d",
      }),
      message: decision => `You've reached the daily limit of ${decision.limit} messages. Try again tomorrow.`,
    }),
    mcp({
      servers: {
        nuxt: remoteMcpServer({ url: "https://nuxt.com/mcp" }),
      },
    }),
    transcribe(() => ({
      model: createOpenAI({ apiKey: useServerEnv().openaiApiKey.unseal() }).transcription("gpt-4o-transcribe"),
    })),
  ],
})
