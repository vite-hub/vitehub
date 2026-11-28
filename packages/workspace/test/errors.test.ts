import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { isWorkspaceError, workspaceConflictError, workspaceError, workspaceNotFoundError, workspacePathError, workspaceSourceReadOnlyError } from "../src/core/errors.ts"
import { normalizeSafeWorkspacePath } from "../src/internal/path.ts"

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
      message: '[vitehub] The Workspace path "../secrets" is not a relative path inside the Workspace root. It is empty or absolute, it has a NUL byte, or it has a `.` or `..` part.',
      name: "ViteHubError",
    })
    expect(error).toMatchObject({ docs: "https://vitehub.dev/docs/workspace/diagnostics/workspace_path_invalid", fix: expect.stringContaining("`docs/guide.md`") })
  })

  it.each([".git/config", "docs/.git/HEAD", ".vitehub/state.json", "GIT~1/config", "vitehu~1/state.json"])("names the reserved name in %s", (path) => {
    expect(() => normalizeSafeWorkspacePath(path)).toThrow(expect.objectContaining({
      code: "WORKSPACE_PATH_INVALID",
      details: { path },
      fix: expect.stringContaining("Rename the file or folder"),
      why: expect.stringContaining("uses a reserved name"),
    }))
  })

  it.each(["", "/etc/passwd", "C:/temp", "docs/\0", "../secrets", "docs/./guide.md"])("names a path outside the root in %j", (path) => {
    expect(() => normalizeSafeWorkspacePath(path)).toThrow(expect.objectContaining({
      code: "WORKSPACE_PATH_INVALID",
      why: expect.stringContaining("is not a relative path inside the Workspace root"),
    }))
  })

  it("names the Source that owns a read-only path", () => {
    const error = workspaceSourceReadOnlyError("docs/intro.md", "handbook")
    expect(isWorkspaceError(error)).toBe(true)
    expect(error).toMatchObject({
      code: "WORKSPACE_SOURCE_READ_ONLY",
      details: { path: "docs/intro.md", source: "handbook" },
      fix: expect.stringContaining("`drafts/`"),
      message: '[vitehub] The Workspace path "docs/intro.md" belongs to Source "handbook". Source paths are read-only: a write, removal, or move cannot change them.',
    })
    expect(workspaceSourceReadOnlyError(".vitehub").why).toContain("belongs to a Source.")
  })

  it("gives a conditional write conflict a fix and keeps its message", () => {
    expect(workspaceConflictError("a.md", "old", "new")).toMatchObject({
      code: "WORKSPACE_CONFLICT",
      details: { actual: "new", expected: "old", path: "a.md" },
      fix: expect.stringContaining("`ifDigest`"),
      message: "[vitehub] Workspace path changed before the conditional write: a.md.",
      why: "Workspace path changed before the conditional write: a.md.",
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
