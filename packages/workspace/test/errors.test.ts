import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { workspaceNotFoundError, workspacePathError } from "../src/core/errors.ts"

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
})
