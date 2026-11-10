import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import { consoleSecretProblem, createProjectToken, openProjectToken, sealProjectToken, tokenSha256 } from "../src/token-box.ts"

const secret = "a".repeat(64)

describe("project tokens", () => {
  it("makes 64 hex characters, which the app's token check accepts", () => {
    const token = createProjectToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(createProjectToken()).not.toBe(token)
  })

  it("hashes a token the way VITEHUB_CONSOLE_TOKEN_SHA256 expects", async () => {
    await expect(tokenSha256("token")).resolves.toBe(createHash("sha256").update("token").digest("hex"))
  })

  it("opens a sealed token only with the same secret and project", async () => {
    const sealed = await sealProjectToken(secret, "project-a", "token-a")
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/)
    expect(sealed).not.toContain("token-a")
    await expect(openProjectToken(secret, "project-a", sealed)).resolves.toBe("token-a")
    await expect(openProjectToken("b".repeat(64), "project-a", sealed)).resolves.toBeUndefined()
    // A sealed token copied to another project row does not open.
    await expect(openProjectToken(secret, "project-b", sealed)).resolves.toBeUndefined()
  })

  it.each([
    ["another format", "v2.abc.def"],
    ["a changed ciphertext", "flip"],
    ["a short iv", "v1.AAAA.AAAA"],
    ["an extra part", "extra"],
  ])("refuses %s", async (_, kind) => {
    const sealed = await sealProjectToken(secret, "p", "t")
    const value = kind === "flip"
      ? `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`
      : kind === "extra" ? `${sealed}.AAAA` : kind
    await expect(openProjectToken(secret, "p", value)).resolves.toBeUndefined()
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
