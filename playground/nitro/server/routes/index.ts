import { defineEventHandler } from "h3"

export default defineEventHandler(() => ({
  ok: true,
  chat: "nitro-playground",
  env: true,
  queue: "welcome",
  workflow: "welcome",
}))
