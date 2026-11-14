import { describe, expect, it } from "vitest"

import { consoleSecretProblem, openProjectKey, sealProjectKey } from "../src/token-box.ts"

const secret = "a".repeat(64)

describe("project key box", () => {
  it("opens a sealed key only with the same secret and project", async () => {
    const sealed = await sealProjectKey(secret, "project-a", "key-a")
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/)
    expect(sealed).not.toContain("key-a")
    await expect(openProjectKey(secret, "project-a", sealed)).resolves.toBe("key-a")
    await expect(openProjectKey("b".repeat(64), "project-a", sealed)).resolves.toBeUndefined()
    // A sealed key copied to another project row does not open.
    await expect(openProjectKey(secret, "project-b", sealed)).resolves.toBeUndefined()
  })

  it.each([
    ["another format", "v2.abc.def"],
    ["a changed ciphertext", "flip"],
    ["a short iv", "v1.AAAA.AAAA"],
    ["an extra part", "extra"],
  ])("refuses %s", async (_, kind) => {
    const sealed = await sealProjectKey(secret, "p", "t")
    const value = kind === "flip"
      ? `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`
      : kind === "extra" ? `${sealed}.AAAA` : kind
    await expect(openProjectKey(secret, "p", value)).resolves.toBeUndefined()
  })

  it.each([
    [undefined, "Set VITEHUB_CONSOLE_SECRET"],
    ["  ", "Set VITEHUB_CONSOLE_SECRET"],
    ["short", "fewer than 32 characters"],
  ])("says how to set a missing or short secret: %j", (value, message) => {
    expect(consoleSecretProblem(value)).toContain(message)
  })

  it("accepts a secret of 32 characters or more", () => {
    expect(consoleSecretProblem(secret)).toBeUndefined()
  })
})
