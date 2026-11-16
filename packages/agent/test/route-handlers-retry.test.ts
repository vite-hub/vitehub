import { describe, expect, it, vi } from "vitest"

import { createTelegramPollingRouteHandler } from "../src/server/route-handlers.ts"

// The routes module fails to load once, as an import can fail during a development rebuild.
const routes = vi.hoisted(() => ({ failures: 1 }))

vi.mock("../src/server/routes.ts", () => {
  if (routes.failures > 0) {
    routes.failures--
    throw new Error("transient routes import failure")
  }
  return { createTelegramPollingRouteHandler: () => async () => new Response("ok") }
})

describe("Agent route handlers", () => {
  it("loads the routes module again on the next request after a failed load", async () => {
    const handler = createTelegramPollingRouteHandler({} as never)
    const request = new Request("https://example.com/telegram")

    await expect(handler(request)).rejects.toThrow()
    await expect((await handler(request)).text()).resolves.toBe("ok")
  })
})
