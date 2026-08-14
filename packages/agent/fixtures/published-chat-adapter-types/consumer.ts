import { createTelegramAdapter } from "@chat-adapter/telegram"
import { telegram } from "@vite-hub/agent/channels"
import { createAgentChatData } from "@vite-hub/agent"
import type { AgentChatPlatformAdapter } from "@vite-hub/agent"

const adapter = createTelegramAdapter({
  allowedUserIds: ["123"],
  botToken: "typecheck-only",
})

adapter satisfies AgentChatPlatformAdapter

telegram({
  adapter: () => adapter,
})

createAgentChatData([
  { data: { title: "Inventory" }, type: "data-title" },
]).get("title", "title") satisfies string | undefined
