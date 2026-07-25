import { createTelegramAdapter } from "@chat-adapter/telegram"
import { telegram } from "@vite-hub/agent/channels"
import type { AgentChatPlatformAdapter } from "@vite-hub/agent"

const adapter = createTelegramAdapter({
  allowedUserIds: ["123"],
  botToken: "typecheck-only",
})

adapter satisfies AgentChatPlatformAdapter

telegram({
  adapter: () => adapter,
})
