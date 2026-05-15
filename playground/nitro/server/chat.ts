import { defineChat } from "@vitehub/chat"

import type { StateAdapter } from "chat"

const state = {} as StateAdapter

export default defineChat({
  adapters: {},
  agent: {
    history: { source: "thread", maxMessages: 12 },
    hooks: {
      async error({ error, thread }) {
        await thread.post(`Agent failed: ${error instanceof Error ? error.message : "unknown error"}`)
      },
    },
    name: "triager",
  },
  streamingUpdateIntervalMs: 500,
  state,
  userName: "nitro-playground",
})
