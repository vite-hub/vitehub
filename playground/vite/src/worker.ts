import { createApp, defineEventHandler } from "h3"

import { registerQueueRoutes } from "./services/queue.ts"

const app = createApp()

app.get("/", defineEventHandler(() => ({
  ok: true,
  services: ["queue"],
  server: "h3",
})))

registerQueueRoutes(app)

export default app
