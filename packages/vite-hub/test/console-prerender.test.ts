import { describe, expect, it } from "vitest"

import { addConsolePageHandlers } from "../src/console/nitro.ts"

describe("Console pages and the prerender crawler", () => {
  it("keeps the crawler away from the Console pages, which need a signed-in request", () => {
    const nitro: Parameters<typeof addConsolePageHandlers>[0] = { prerender: { ignore: ["/private"] } }
    addConsolePageHandlers(nitro, "/runtime")
    addConsolePageHandlers(nitro, "/runtime")
    expect(nitro.prerender?.ignore).toEqual(["/private", "/_vitehub"])
  })

  it("ignores the Console below the application base", () => {
    const nitro: Parameters<typeof addConsolePageHandlers>[0] = {}
    addConsolePageHandlers(nitro, "/runtime", "/docs/")
    expect(nitro.prerender?.ignore).toEqual(["/docs/_vitehub"])
  })
})
