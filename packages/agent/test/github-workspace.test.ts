import { describe, expect, it, vi } from "vitest"
import { createGitHubWorkspaceInspector } from "../src/server/github-workspace.ts"
import { githubForge } from "./fixtures/github-forge.ts"

const revision = { repository: "acme/app", revision: "a".repeat(40) }
async function fixture(payload: unknown) {
  const github = await githubForge(() => payload)
  const forge = vi.fn(async () => github.provider)
  return { calls: github.calls, forge, workspace: createGitHubWorkspaceInspector({ forge }) }
}
describe("GitHub Workspace inspection", () => {
  it("lists immutable files without exposing directories", async () => {
    const { workspace, calls } = await fixture({ tree: [{ type: "blob", path: "a.ts" }, { type: "tree", path: "src" }] })
    expect(await workspace.list(revision)).toEqual(["a.ts"])
    expect(calls[0]?.url.href).toBe(`https://api.github.com/repos/acme/app/git/trees/${revision.revision}?recursive=1`)
  })
  it("rejects truncated trees", async () => {
    await expect((await fixture({ tree: [], truncated: true })).workspace.list(revision)).rejects.toThrow("too large")
  })
  it("reads UTF-8 from the same revision", async () => {
    const { workspace, calls } = await fixture({ type: "file", path: "src/a b.ts", sha: "b", encoding: "base64", size: 2, content: "w6k=" })
    expect(await workspace.read(revision, "src/a b.ts")).toEqual({ content: "é", path: "src/a b.ts", revision: revision.revision, size: 2 })
    expect(calls[0]?.url.href).toBe(`https://api.github.com/repos/acme/app/contents/src/a%20b.ts?ref=${revision.revision}`)
  })
  it.each(["../secret", "/secret", "a/../secret", "a//b", "a\0b"])("rejects invalid path %s before access", async path => {
    const { workspace, forge } = await fixture({})
    await expect(workspace.read(revision, path)).rejects.toThrow("Invalid Workspace path")
    expect(forge).not.toHaveBeenCalled()
  })
  it.each(["/w==", "AA=="])("rejects binary content %s", async content => {
    await expect((await fixture({ type: "file", path: "a", sha: "b", encoding: "base64", size: 1, content })).workspace.read(revision, "a")).rejects.toThrow("binary")
  })
  it("checks decoded size even when metadata underreports it", async () => {
    await expect((await fixture({ type: "file", path: "a", sha: "b", encoding: "base64", size: 1, content: Buffer.alloc(512 * 1024 + 1).toString("base64") })).workspace.read(revision, "a")).rejects.toThrow("too large")
  })
})
