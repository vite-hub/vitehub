import { createTelegramAdapter } from "@chat-adapter/telegram"
import { defineChat } from "@vitehub/chat"
import { cloudflareDurableObjectState } from "@vitehub/chat/cloudflare"
import { createWorkflow } from "@vitehub/workflow"

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

interface ChatReplyPayload {
  messageId: string
  platform: string
  text: string
  threadId: string
  vertex: ChatRuntimeConfig["vertex"]
}

export default defineChat<ChatRuntimeConfig>({
  adapters: ({ runtimeConfig }) => ({
    telegram: createTelegramAdapter(runtimeConfig.telegram),
  }),
  async onDirectMessage({ message, runtimeConfig, thread, workflow }) {
    await thread.startTyping().catch(() => {})

    const run = await workflow.run({
      messageId: message.id,
      platform: "telegram",
      text: message.text,
      threadId: thread.id,
      vertex: runtimeConfig.vertex,
    })
    const result = await workflow.getRun(run.id)
    if (result.status === "completed") {
      await thread.post(result.result!.fullStream)
    }
  },
  state: cloudflareDurableObjectState({
    name: "quiver-chat",
  }),
  streamingUpdateIntervalMs: 1_000,
  workflow: createWorkflow<ChatReplyPayload, { fullStream: AsyncIterable<string> }>({
    name: "chat-reply",
    async handler({ payload }) {
      async function answerWithContext(prompt: string, _apiKey: string, _model: string) {
        return {
          fullStream: (async function* () {
            yield `Echo: ${prompt}`
          })(),
        }
      }

      return await answerWithContext(payload.text, payload.vertex.apiKey, payload.vertex.model)
    },
    id: ({ payload: { messageId, threadId } }) => `${threadId}:${messageId}`,
  }),
})
