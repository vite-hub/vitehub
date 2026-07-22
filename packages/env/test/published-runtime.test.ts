import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const env = await import(distEntry.href)

describe("published Env runtime", () => {
  it("does not publish a package-specific error constructor", () => {
    expect(env).not.toHaveProperty("EnvError")
  })
})
