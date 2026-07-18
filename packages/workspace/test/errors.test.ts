import type { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { WorkspaceNotFoundError, WorkspacePathError } from "../src/index.ts"
import { WorkspaceError } from "../src/core/errors.ts"

describe("Workspace public errors", () => {
  it("serializes missing Workspace failures through the shared contract", () => {
    const cause = new Error("private provider response")
    const error = new WorkspaceNotFoundError("documents")
    Object.defineProperty(error, "cause", { value: cause })
    Object.assign(error, { providerToken: "secret" })

    const contract: ViteHubError<"WORKSPACE_NOT_FOUND", { name: string }> = error

    expect(contract).toBe(error)
    expect(error).toBeInstanceOf(WorkspaceError)
    expect(error).toBeInstanceOf(WorkspaceNotFoundError)
    expect(error.name).toBe("WorkspaceNotFoundError")
    expect(error.message).toBe("[vitehub] Workspace is not registered.")
    expect(error.toJSON()).toEqual({
      code: "WORKSPACE_NOT_FOUND",
      details: { name: "documents" },
      message: "[vitehub] Workspace is not registered.",
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain("providerToken")
    expect(JSON.stringify(error)).not.toContain("private provider response")
    expect(JSON.stringify(error)).not.toContain("stack")
  })

  it("serializes invalid Workspace paths with a bounded reason", () => {
    const error = new WorkspacePathError("../secrets")

    const contract: ViteHubError<"WORKSPACE_PATH_INVALID", { reason: "traversal" | "absolute" | "empty" | "invalid" | "reserved" }> = error

    expect(contract).toBe(error)
    expect(error).toBeInstanceOf(WorkspaceError)
    expect(error).toBeInstanceOf(WorkspacePathError)
    expect(error.name).toBe("WorkspacePathError")
    expect(error.message).toBe("[vitehub] Workspace path is invalid.")
    expect(error.toJSON()).toEqual({
      code: "WORKSPACE_PATH_INVALID",
      details: { reason: "traversal" },
      message: "[vitehub] Workspace path is invalid.",
      retryable: false,
    })
  })

  it("does not expose unsafe Workspace names or paths", () => {
    const secret = "https://user:password@example.test/workspace?token=private-token"
    const missing = new WorkspaceNotFoundError(secret)
    const invalidPath = new WorkspacePathError(`../.env?token=${secret}`)

    expect(missing.toJSON()).toEqual({
      code: "WORKSPACE_NOT_FOUND",
      message: "[vitehub] Workspace is not registered.",
      retryable: false,
    })
    expect(invalidPath.toJSON()).toEqual({
      code: "WORKSPACE_PATH_INVALID",
      details: { reason: "traversal" },
      message: "[vitehub] Workspace path is invalid.",
      retryable: false,
    })
    expect(JSON.stringify(missing)).not.toContain(secret)
    expect(JSON.stringify(invalidPath)).not.toContain(secret)
  })

  it("handles arbitrary constructor values without inspecting them", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("private getter value")
      },
    })

    expect(() => JSON.stringify(new WorkspaceNotFoundError(hostile as never))).not.toThrow()
    expect(() => JSON.stringify(new WorkspacePathError(hostile as never))).not.toThrow()
  })
})
