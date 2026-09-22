import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { workspaceError, workspaceNotFoundError, workspacePathError } from "../src/core/errors.ts"

describe("Workspace public errors", () => {
  it("uses ViteHubError for missing Workspaces", () => {
    const error = workspaceNotFoundError("documents")
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.toJSON()).toEqual({
      code: "WORKSPACE_NOT_FOUND",
      details: { name: "documents" },
      message: '[vitehub] Workspace "documents" is not registered.',
      name: "ViteHubError",
    })
  })

  it("uses ViteHubError for invalid Workspace paths", () => {
    const error = workspacePathError("../secrets")
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.toJSON()).toEqual({
      code: "WORKSPACE_PATH_INVALID",
      details: { path: "../secrets" },
      message: '[vitehub] Workspace path escapes the workspace root: "../secrets".',
      name: "ViteHubError",
    })
  })

  it("bounds invalid Workspace paths", () => {
    const error = workspacePathError(`../${"x".repeat(20_000)}`)
    expect(error.code).toBe("WORKSPACE_PATH_INVALID")
    expect(error.details?.path).toHaveLength(4_096)
  })

  it("classifies missing Workspace files and paths as not found", () => {
    expect(workspaceError("[vitehub] Workspace file does not exist: AGENTS.md.").code).toBe("WORKSPACE_NOT_FOUND")
    expect(workspaceError("[vitehub] Workspace path does not exist: docs/missing.").code).toBe("WORKSPACE_NOT_FOUND")
    expect(workspaceError("[vitehub] Custom Workspace Source file does not exist: missing.md.").code).toBe("WORKSPACE_NOT_FOUND")
  })

  it("keeps other Workspace failures unchanged", () => {
    expect(workspaceError("[vitehub] Workspace operation failed.").code).toBe("WORKSPACE_FAILED")
    expect(workspaceError("[vitehub] Rule rejected a path containing Workspace path does not exist:.").code).toBe("WORKSPACE_FAILED")
  })
})
