import { describe, expectTypeOf, it } from "vitest"

import { ask } from "../src/ask.ts"
import { jev } from "../src/gateways.ts"

import type { AskChoiceAnswer } from "../src/ask.ts"

describe("jev()", () => {
  it("types the answers from the questions", () => {
    const answers = jev().ask("Invoice 42", { label: ask.choice("Which label?", ["invoice", "none"]), spam: ask.if("Is it spam?") })

    expectTypeOf(answers).resolves.toEqualTypeOf<{
      readonly label: AskChoiceAnswer<{ invoice: null, none: null }>
      readonly spam: boolean
    }>()
  })

  it("requires the credentials of the selected provider", () => {
    jev({ apiKey: "ts-key", provider: "typesafe" })
    jev({ provider: "vercel" })
    jev({ apiKey: "ts-key", cloudflare: { accountId: "account", gatewayId: "gateway" }, provider: "cloudflare" })
    // @ts-expect-error A key without a provider would be ignored.
    jev({ apiKey: "ts-key" })
    // @ts-expect-error The TypeSafe API needs a key.
    jev({ provider: "typesafe" })
    // @ts-expect-error Cloudflare needs the account and gateway.
    jev({ apiKey: "ts-key", provider: "cloudflare" })
  })
})
