import { describe, expectTypeOf, it } from "vitest"

import { codexDriver, defineAgent } from "../src/index.ts"

describe("provider Agent Driver types", () => {
  it("carries invocation options into trusted-host Box callbacks", () => {
    const driver = codexDriver<{ checkout: string }>({ model: "gpt-5.6-sol" })

    defineAgent({
      box: {
        runtime: "trusted-host",
        cwd: ({ input }) => {
          expectTypeOf(input.options).toEqualTypeOf<{ checkout: string } | undefined>()
          return input.options!.checkout
        },
      },
      driver,
    })
  })
})
