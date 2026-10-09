import { describe, expect, it } from "vitest"

import { isViteHubBearerSecretEqual, isViteHubSecretEqual } from "../src/secret.ts"

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
