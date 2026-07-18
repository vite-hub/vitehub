import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { SourceError, SourceNotFoundError, SourcePathError } from "../src/index.ts"

describe("@vite-hub/source public errors", () => {
  it("serializes stable fields without internal causes or stacks", () => {
    const cause = new Error("authorization=Bearer secret-token at https://provider.example/private")
    const error = new SourceError({
      cause,
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: { operation: "read-item", provider: "github", status: 503 },
      message: "[vitehub] github source request failed during read-item.",
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: { operation: "read-item", provider: "github", status: 503 },
      message: "[vitehub] github source request failed during read-item.",
    })
    expect(JSON.stringify(error)).not.toContain("secret-token")
    expect(JSON.stringify(error)).not.toContain("provider.example")
    expect(JSON.stringify(error)).not.toContain("stack")
  })

  it("retains positional construction compatibility", () => {
    const cause = new Error("Bearer secret-token")
    const error = new SourceError("Bearer secret-token", {
      cause,
      code: "SOURCE_ITEM_NOT_FOUND",
      details: { key: "README.md", source: "docs" },
    })

    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "SOURCE_ITEM_NOT_FOUND",
      details: { key: "README.md", source: "docs" },
      message: "[vitehub] docs could not find \"README.md\".",
    })
    expect(JSON.stringify(error)).not.toContain("secret-token")
  })

  it("derives object-constructor messages from safe code-owned context", () => {
    const error = new SourceError({
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: { operation: "read", provider: "custom" },
      message: "Bearer secret-token at https://provider.example/private",
    })

    expect(error.toJSON()).toEqual({
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: { operation: "read", provider: "custom" },
      message: "[vitehub] custom source request failed during read.",
    })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|provider\.example/)
  })

  it("rejects unknown codes in both constructor forms", () => {
    expect(() => new SourceError({
      code: "Bearer secret-token at https://provider.example/private" as never,
      message: "Provider failed.",
    })).toThrow(new TypeError("[vitehub] Invalid Source error code."))
    expect(() => new SourceError("Provider failed.", {
      code: "Bearer secret-token at https://provider.example/private" as never,
    })).toThrow(new TypeError("[vitehub] Invalid Source error code."))
  })

  it("allows only observed provider details at runtime", () => {
    const error = new SourceError({
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: {
        operation: "read-item",
        provider: "github",
        token: "secret-token",
      } as never,
      message: "Provider failed.",
    })

    expect(error.toJSON()).toEqual({
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: { operation: "read-item", provider: "github" },
      message: "[vitehub] github source request failed during read-item.",
    })
    for (const [code, details] of [
      ["SOURCE_PROVIDER_REQUEST_FAILED", { operation: "Bearer secret-token at https://provider.example/private", provider: "github" }],
      ["SOURCE_PROVIDER_REQUEST_FAILED", { operation: "read-item", provider: "private-provider" }],
      ["SOURCE_PROVIDER_REQUEST_FAILED", { operation: "read-item", provider: "github", status: 99 }],
      ["SOURCE_PATH_INVALID", { field: "path", valueType: "private-value-type" }],
    ] as const) {
      expect(() => new SourceError({
        code: code as never,
        details: details as never,
        message: "Provider failed.",
      })).toThrow(new TypeError("[vitehub] Invalid Source error details."))
    }
  })

  it("omits unsafe source names and paths from serialized errors", () => {
    const source = new SourceNotFoundError("https://user:secret-token@provider.example/private")
    const path = new SourcePathError("/Users/private/project/.env")

    expect(source.toJSON()).toEqual({
      code: "SOURCE_NOT_FOUND",
      message: "[vitehub] Source is not registered.",
    })
    expect(path.toJSON()).toEqual({
      code: "SOURCE_PATH_INVALID",
      details: { field: "path", valueType: "string" },
      message: "[vitehub] Source path escapes the source root.",
    })
    expect(JSON.stringify([source, path])).not.toMatch(/secret-token|provider\.example|\/Users\/private|\.env/)
  })
})
