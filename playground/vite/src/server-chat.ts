import { H3 } from "h3"

import agent from "../server/agents/cli-dev"

const app = new H3()

app.get("/", () => ({
  agent: Boolean(agent),
  ok: true,
}))

export default app
