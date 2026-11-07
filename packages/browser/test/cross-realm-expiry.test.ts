import { describe, expect, it } from "vitest"
import vm from "node:vm"
import { createBrowser, type BrowserDriver } from "../src/index.ts"

describe("browser session expiry boundaries", () => {
  it("serializes a provider Date from another realm", async () => {
    const expiresAt = vm.runInNewContext("new Date('2030-01-02T03:04:05.000Z')") as Date
    const provider: BrowserDriver = {
      features: { liveHandoff: false },
      isolation: "provider",
      name: "fixture",
      async open() {
        return { close() {}, connection: {}, expiresAt, id: "provider" }
      },
    }
    const session = await createBrowser({ driver: provider }).open()
    expect(session.inspect().expiresAt).toBe("2030-01-02T03:04:05.000Z")
  })
})
