import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const queue = await import(distEntry.href)

describe("published Queue error runtime", () => {
  it("does not publish a package-specific error constructor", () => {
    expect(queue).not.toHaveProperty("QueueError")
  })
})
