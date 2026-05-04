import { defineChat } from "@vitehub/chat"

import type { StateAdapter } from "chat"

const state = {} as StateAdapter

export default defineChat({
  adapters: {},
  state,
  userName: "vite-playground",
})
