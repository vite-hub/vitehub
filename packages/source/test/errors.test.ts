import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { SourceError, SourceNotFoundError, SourcePathError } from "../src/index.ts"

describe("@vite-hub/source public errors", () => {
  it("serializes stable fields without internal causes or stacks", () => {
    const cause = new Error("authorization=Bearer secret-token at https://provider.example/private")
    const error = new SourceError("[vitehub] github source request failed during read-item.", {
      cause,
      code: "SOURCE_PROVIDER_REQUEST_FAILED",
      details: { operation: "read-item", provider: "github", status: 503 },
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
