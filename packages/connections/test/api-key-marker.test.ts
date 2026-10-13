import { describe, expect, it } from "vitest"

import { isApiKeyProvider } from "../src/api-key.ts"
import { defineConnection } from "../src/definition.ts"

describe("API-key provider markers", () => {
  it("does not infer an API-key provider from an inherited kind marker", () => {
    const provider = Object.assign(Object.create({ kind: "api-key" }), {
      id: "inherited-marker",
      header: "authorization",
      origins: ["https://api.example.com"],
      apis: {},
    })
    expect(isApiKeyProvider(provider as never)).toBe(false)
    expect(() => defineConnection({ provider: provider as never })).toThrow()
  })
})
