import { describe, expect, it, vi } from "vitest"
import type { GitHubHost } from "../src/server/github-host.ts"
import { createGitHubWorkspaceInspector } from "../src/server/github-workspace.ts"

const revision = { repository: "acme/app", revision: "a".repeat(40) }
function fixture(payload: unknown) {
  const command = vi.fn<GitHubHost["command"]>(async () => ({ stderr: "", stdout: JSON.stringify(payload) }))
  return { command, workspace: createGitHubWorkspaceInspector({ command }) }
}
describe("GitHub Workspace inspection", () => {
  it("lists immutable files without exposing directories", async () => {
    const { workspace, command } = fixture({ tree: [{ type: "blob", path: "a.ts" }, { type: "tree", path: "src" }] })
    expect(await workspace.list(revision)).toEqual(["a.ts"])
    expect(command.mock.calls[0]).toEqual([["api", "--method", "GET", "-f", "recursive=1", `repos/acme/app/git/trees/${revision.revision}`], { repository: "acme/app" }])
  })
  it("rejects truncated trees", async () => {
    await expect(fixture({ tree: [], truncated: true }).workspace.list(revision)).rejects.toThrow("too large")
  })
  it("reads UTF-8 from the same revision", async () => {
    const { workspace, command } = fixture({ type: "file", encoding: "base64", size: 2, content: "w6k=" })
    expect(await workspace.read(revision, "src/a b.ts")).toEqual({ content: "é", path: "src/a b.ts", revision: revision.revision, size: 2 })
    expect(command.mock.calls[0]?.[0]).toContain("repos/acme/app/contents/src/a%20b.ts")
  })
  it.each(["../secret", "/secret", "a/../secret", "a//b", "a\0b"])("rejects invalid path %s before access", async path => {
    const { workspace, command } = fixture({})
    await expect(workspace.read(revision, path)).rejects.toThrow("Invalid Workspace path")
    expect(command).not.toHaveBeenCalled()
  })
  it.each(["/w==", "AA=="])("rejects binary content %s", async content => {
    await expect(fixture({ type: "file", encoding: "base64", size: 1, content }).workspace.read(revision, "a")).rejects.toThrow("binary")
  })
  it("checks decoded size even when metadata underreports it", async () => {
    await expect(fixture({ type: "file", encoding: "base64", size: 1, content: Buffer.alloc(512 * 1024 + 1).toString("base64") }).workspace.read(revision, "a")).rejects.toThrow("too large")
  })
})
