import "@vitehub/db/virtual"
import schema from "virtual:@vitehub/db/schema"

import { describe, expectTypeOf, it } from "vitest"

describe("published virtual-module types", () => {
  it("loads the ambient virtual schema declarations from the virtual subpath", () => {
    expectTypeOf(schema).toMatchTypeOf<Record<string, unknown>>()
  })
})
