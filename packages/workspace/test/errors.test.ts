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
    expect(error.message).toBe('[vitehub] Workspace "documents" is not registered.')
    expect(error.toJSON()).toEqual({
      code: "WORKSPACE_NOT_FOUND",
      details: { name: "documents" },
      message: '[vitehub] Workspace "documents" is not registered.',
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain("providerToken")
    expect(JSON.stringify(error)).not.toContain("private provider response")
    expect(JSON.stringify(error)).not.toContain("stack")
  })

  it("serializes invalid Workspace paths with allowlisted details", () => {
    const error = new WorkspacePathError("../secrets")

    const contract: ViteHubError<"WORKSPACE_PATH_INVALID", { path: string }> = error

    expect(contract).toBe(error)
    expect(error).toBeInstanceOf(WorkspaceError)
    expect(error).toBeInstanceOf(WorkspacePathError)
    expect(error.name).toBe("WorkspacePathError")
    expect(error.message).toBe('[vitehub] Workspace path escapes the workspace root: "../secrets".')
    expect(error.toJSON()).toEqual({
      code: "WORKSPACE_PATH_INVALID",
      details: { path: "../secrets" },
      message: '[vitehub] Workspace path escapes the workspace root: "../secrets".',
      retryable: false,
    })
  })
})
