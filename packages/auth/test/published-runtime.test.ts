import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/agent.js", import.meta.url)
const auth = await import(distEntry.href)

describe("published Auth runtime", () => {
  it("does not publish package-specific error constructors", () => {
    expect(auth).not.toHaveProperty("AuthenticationRequiredError")
    expect(auth).not.toHaveProperty("AuthenticationProviderError")
  })
})
