import { defineChat } from "@vitehub/agent/chat"

import type { StateAdapter } from "chat"

const state = {} as StateAdapter

export default defineChat({
  adapters: {},
  state,
  userName: "vite-playground",
})
