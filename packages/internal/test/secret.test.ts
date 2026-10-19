import { describe, expect, it } from "vitest"

import { deriveViteHubSecret, isViteHubBearerSecretEqual, isViteHubSecretEqual, readViteHubSecret } from "../src/secret.ts"

describe("request secret comparison", () => {
  it("compares secrets in full and rejects missing values", () => {
    expect(isViteHubSecretEqual("token", "token")).toBe(true)
    expect(isViteHubSecretEqual("tokem", "token")).toBe(false)
    expect(isViteHubSecretEqual("toke", "token")).toBe(false)
    expect(isViteHubSecretEqual("token-", "token")).toBe(false)
    expect(isViteHubSecretEqual("tökén", "tökén")).toBe(true)
    expect(isViteHubSecretEqual(undefined, "token")).toBe(false)
    expect(isViteHubSecretEqual(null, "token")).toBe(false)
    expect(isViteHubSecretEqual("", "")).toBe(false)
    expect(isViteHubSecretEqual("token", undefined)).toBe(false)
  })

  it("compares the token of a Bearer authorization header", () => {
    expect(isViteHubBearerSecretEqual("Bearer token", "token")).toBe(true)
    expect(isViteHubBearerSecretEqual("bearer  token", "token")).toBe(true)
    expect(isViteHubBearerSecretEqual("Bearer tokem", "token")).toBe(false)
    expect(isViteHubBearerSecretEqual("Bearer toke", "token")).toBe(false)
    expect(isViteHubBearerSecretEqual("Bearer token-", "token")).toBe(false)
    expect(isViteHubBearerSecretEqual("Basic token", "token")).toBe(false)
    expect(isViteHubBearerSecretEqual("token", "token")).toBe(false)
    expect(isViteHubBearerSecretEqual("Bearer ", "token")).toBe(false)
    expect(isViteHubBearerSecretEqual(null, "token")).toBe(false)
    expect(isViteHubBearerSecretEqual("Bearer token", undefined)).toBe(false)
  })
})

describe("root secret derivation", () => {
  const root = "r".repeat(44)

  it("matches HKDF-SHA256 with the vitehub salt and the purpose as info", async () => {
    const { hkdfSync } = await import("node:crypto")
    const expected = Buffer.from(hkdfSync("sha256", root, "vitehub", "vitehub:dispatch", 32)).toString("hex")
    await expect(deriveViteHubSecret(root, "vitehub:dispatch")).resolves.toBe(expected)
  })

  it("derives a distinct stable secret for each purpose", async () => {
    const first = await deriveViteHubSecret(root, "a")
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await expect(deriveViteHubSecret(root, "a")).resolves.toBe(first)
    await expect(deriveViteHubSecret(root, "b")).resolves.not.toBe(first)
  })

  it("rejects a short root and an empty purpose", async () => {
    await expect(deriveViteHubSecret("short", "a")).rejects.toThrow(/at least 32 characters/)
    await expect(deriveViteHubSecret(root, "")).rejects.toThrow(/purpose/)
  })

  it("reads VITEHUB_SECRET before NUXT_APP_SECRET", () => {
    expect(readViteHubSecret({ NUXT_APP_SECRET: "nuxt", VITEHUB_SECRET: "vitehub" })).toBe("vitehub")
    expect(readViteHubSecret({ NUXT_APP_SECRET: "nuxt", VITEHUB_SECRET: "" })).toBe("nuxt")
    expect(readViteHubSecret({ VITEHUB_SECRET: 1 })).toBeUndefined()
  })
})
