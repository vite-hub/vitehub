import { expectTypeOf, it } from "vitest"

import { codexDriver, defineAgent } from "@vite-hub/agent"
import { pollGmailChannel, type GmailChannel } from "@vite-hub/agent/channels"
import { labeller } from "../src/labeller.ts"

it("types the Gmail Channel of an Agent that extends the Labeller", () => {
  const agent = defineAgent({ extends: labeller, options: { labels: { Receipts: { description: "Purchases" } } } })
  expectTypeOf(agent.channels.gmail).toEqualTypeOf<GmailChannel>()
  void pollGmailChannel(agent.channels.gmail)

  const child = defineAgent({ extends: agent, driver: codexDriver() })
  expectTypeOf(child.channels.gmail).toEqualTypeOf<GmailChannel>()
})
