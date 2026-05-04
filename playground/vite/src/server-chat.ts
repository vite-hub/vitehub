import { H3 } from "h3"

import chat from "../server/chat"

const app = new H3()

app.get("/", () => ({
  chat: Boolean(chat),
  ok: true,
}))

export default app
