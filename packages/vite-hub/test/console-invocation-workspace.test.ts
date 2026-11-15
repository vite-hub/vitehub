import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ inspector: vi.fn(), get: vi.fn(), definition: vi.fn(), glob: vi.fn(), exists: vi.fn(), stat: vi.fn(), readFile: vi.fn(), refs: vi.fn(), list: vi.fn(), open: vi.fn(), useWorkspaceFiles: vi.fn() }))
vi.mock("@vite-hub/agent/server", () => ({ agentHostWorkspaceRoute: "/_vitehub/api/invocations/:id/workspace", getAgentHostWorkspaceInspector: mocks.inspector }))
vi.mock("../src/console/runtime/server/invocations.ts", () => ({ getConsoleInvocations: () => ({ get: mocks.get }) }))
vi.mock("../src/console/runtime/server/agents.ts", () => ({ getConsoleAgentDefinition: mocks.definition }))
vi.mock("@vite-hub/workspace/files", () => ({ useWorkspaceFiles: mocks.useWorkspaceFiles }))
import handlerRoute from "../src/console/runtime/server/invocation-workspace.get.ts"
import filesHandlerRoute from "../src/console/runtime/server/workspace-files.get.ts"
import { allowed } from "./support/console-access.ts"
import { consoleEvent } from "./console-event.ts"
const handler = allowed(handlerRoute)
const filesHandler = allowed(filesHandlerRoute)
const request = (path?: string, query: Record<string, string> = {}) => {
  const params = new URLSearchParams(path === undefined ? query : { ...query, path })
  const search = params.toString()
  return consoleEvent({ context: { params: { id: "run" } }, url: `http://localhost/_vitehub/api/invocations/run/workspace${search ? `?${search}` : ""}` })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks })
  mocks.get.mockResolvedValue({ agentName: "bot", observations: [{ attributes: { "vitehub.agent.configuration": { workspace: { name: "bot" } } } }] })
  mocks.definition.mockReturnValue({ workspace: { name: "bot" } })
  mocks.glob.mockResolvedValue([{ path: "AGENTS.md", type: "file" }, { path: ".env", type: "file" }, { path: "repo/.git/config", type: "file" }, { path: "src", type: "directory" }])
  mocks.stat.mockResolvedValue({ type: "file", size: 4 })
  mocks.exists.mockResolvedValue(true)
  mocks.readFile.mockResolvedValue("test")
})
describe("Workspace files inspection", () => {
  const filesRequest = (query: Record<string, string> = {}) => consoleEvent({
    url: `http://localhost/_vitehub/api/workspaces/files?${new URLSearchParams({ name: "bot", ...query })}`,
  })

  it("shows mounted files when the Store exposes history methods but retains no history", async () => {
    mocks.refs.mockRejectedValue(Object.assign(new Error("No retained history"), { code: "WORKSPACE_R0069" }))
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    expect(await filesHandler(filesRequest())).toEqual({ paths: ["AGENTS.md"], repository: "bot", revision: "current" })
    expect(mocks.glob).toHaveBeenCalledOnce()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it.each(["refs", "list"] as const)("reports a retained-history provider failure from %s", async operation => {
    const error = new Error("History provider unavailable")
    const head = { id: "main-head", ref: "main", parentId: null, createdAt: "2026-11-07T09:00:00.000Z", files: 1, bytes: 4 }
    mocks.refs.mockResolvedValue([{ name: "main", head }])
    mocks[operation].mockRejectedValue(error)
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    await expect(filesHandler(filesRequest())).rejects.toBe(error)
    await expect(handler(request())).rejects.toBe(error)
    expect(mocks.glob).not.toHaveBeenCalled()
  })

  it("reads a mounted file using the current revision returned by the browser descriptor", async () => {
    mocks.refs.mockRejectedValue(Object.assign(new Error("No retained history"), { code: "WORKSPACE_R0069" }))
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    expect(await filesHandler(filesRequest({ path: "AGENTS.md", revision: "current" }))).toEqual({
      path: "AGENTS.md", content: "test", revision: "current", size: 4,
    })
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it.each<Record<string, string>>([{}, { ref: "run-1" }])("uses one ref for revision files, paged history, and changes with %j", async (selection) => {
    const main = { id: "main-head", ref: "main", parentId: null, createdAt: "2026-11-07T09:00:00.000Z", files: 1, bytes: 4 }
    const run = { ...main, id: "run-head", ref: "run-1" }
    mocks.refs.mockResolvedValue([{ name: "main", head: main }, { name: "run-1", head: run }])
    mocks.list.mockImplementation(async ({ ref }: { ref: string }) => ({ revisions: [{ ...run, ref }], cursor: `${ref}:3` }))
    mocks.open.mockImplementation(async (id: string) => ({
      // A known ref must win over the provider's inferred ref after a merge.
      revision: id === main.id ? main : { ...run, ref: selection.ref ? "main" : run.ref },
      list: async () => [{ path: "AGENTS.md", type: "file", digest: id }],
      stat: mocks.stat,
      readFile: mocks.readFile,
    }))
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    expect(await filesHandler(filesRequest({ revision: run.id, cursor: "run-1:2", ...selection }))).toMatchObject({
      ref: "run-1",
      revision: run.id,
      history: { ref: "run-1", revisions: [{ ...run, ref: "run-1" }], cursor: "run-1:3" },
      base: { ref: "main", revision: main.id },
      changes: [{ path: "AGENTS.md", status: "modified" }],
    })
    expect(mocks.list).toHaveBeenCalledWith({ ref: "run-1", cursor: "run-1:2", limit: 20 })
  })
})
describe("invocation Workspace inspection", () => {
  it("opens the newest recorded Workspace configuration after provider preparation", async () => {
    const revision = { id: "prepared-revision", ref: "main", parentId: null, createdAt: "2026-11-07T10:00:00.000Z", files: 1, bytes: 4 }
    const observations = [
      { attributes: { "vitehub.agent.configuration": { workspace: { name: "bot" } } } },
      { attributes: { "vitehub.agent.configuration": { workspace: { name: "bot", ref: "main", revision: revision.id } } } },
      { attributes: { "vitehub.agent.configuration": null } },
    ]
    mocks.get.mockResolvedValue({ agentName: "bot", observations })
    mocks.open.mockResolvedValue({ revision, list: mocks.glob, stat: mocks.stat, readFile: mocks.readFile })
    mocks.refs.mockResolvedValue([{ name: "main", head: revision }])
    mocks.list.mockResolvedValue({ revisions: [revision] })
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    mocks.definition.mockReturnValue(undefined)
    expect(await handler(request())).toMatchObject({ repository: "bot", revision: revision.id, ref: "main" })
    expect(mocks.open).toHaveBeenCalledWith(revision.id)
    expect(observations[0]?.attributes["vitehub.agent.configuration"]).toEqual({ workspace: { name: "bot" } })
  })
  it("uses the host-authorized immutable snapshot when no mounted Workspace exists", async () => {
    mocks.definition.mockReturnValue(undefined)
    mocks.get.mockResolvedValue(undefined)
    const inspect = vi.fn(async () => Response.json({ repository: "org/repo", revision: "abc123", paths: ["AGENTS.md"] }))
    mocks.inspector.mockReturnValue(inspect)
    expect(await handler(request())).toEqual({ repository: "org/repo", revision: "abc123", paths: ["AGENTS.md"] })
    expect(inspect).toHaveBeenCalledWith("run", undefined)
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it.each([undefined, { source: "repository" }])("passes the file path and preserves host provenance %j", async provenance => {
    const file = { content: "test", path: "src/a b.ts", revision: "abc123", size: 4, ...provenance ? { provenance } : {} }
    const inspect = vi.fn(async () => Response.json(file))
    mocks.inspector.mockReturnValue(inspect)
    expect(await handler(request(file.path))).toEqual(file)
    expect(inspect).toHaveBeenCalledWith("run", file.path)
  })
  it.each(["", "repo\nname", "repo\0name", "repo\u007fname"])("rejects invalid host provenance %j", async source => {
    mocks.inspector.mockReturnValue(async () => Response.json({ content: "test", path: "AGENTS.md", revision: "abc123", size: 4, provenance: { source } }))
    await expect(handler(request("AGENTS.md"))).rejects.toThrow()
  })
  it.each([403, 404, 422])("preserves host inspection failure %i without falling back to mounted files", async status => {
    mocks.inspector.mockReturnValue(async () => new Response("Snapshot unavailable", { status }))
    await expect(handler(request())).rejects.toMatchObject({ statusCode: status, statusMessage: "Snapshot unavailable" })
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it("identifies current mounted files without claiming a historical snapshot", async () => {
    expect(await handler(request())).toEqual({ paths: ["AGENTS.md"], repository: "bot", revision: "current" })
    expect(mocks.definition).toHaveBeenCalledWith("bot", "inspect")
    expect(mocks.useWorkspaceFiles).toHaveBeenCalledWith("bot", { mode: "read", refresh: false })
  })
  it("returns retained refs and a paged revision list when the Workspace exposes history", async () => {
    const head = { id: "rev-2", ref: "main", parentId: "rev-1", createdAt: "2026-10-15T10:00:00.000Z", message: "Update docs", files: 2, bytes: 24, metadata: { url: "https://github.com/org/repo/commit/rev-2" } }
    mocks.refs.mockResolvedValue([{ name: "main", head }])
    mocks.list.mockResolvedValue({ revisions: [head], cursor: "main:2" })
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    expect(await handler(request())).toEqual({
      paths: ["AGENTS.md"],
      repository: "bot",
      revision: "current",
      history: { refs: [{ name: "main", head }], ref: "main", revisions: [head], cursor: "main:2" },
    })
    expect(mocks.refs).toHaveBeenCalledOnce()
    expect(mocks.list).toHaveBeenCalledWith({ ref: "main", limit: 20 })
  })
  it("reads a selected immutable revision without falling back to the mounted tree", async () => {
    const revision = { id: "rev-2", ref: "main", parentId: "rev-1", createdAt: "2026-10-15T10:00:00.000Z", message: "Update docs", files: 2, bytes: 24 }
    const view = { revision, list: mocks.glob, stat: mocks.stat, readFile: mocks.readFile }
    mocks.refs.mockResolvedValue([{ name: "main", head: revision }])
    mocks.list.mockResolvedValue({ revisions: [revision] })
    mocks.open.mockResolvedValue(view)
    mocks.stat.mockResolvedValue({ type: "file", size: 4 })
    mocks.readFile.mockResolvedValue("old")
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    expect(await handler(request("AGENTS.md", { revision: "rev-2", ref: "main" }))).toEqual({ path: "AGENTS.md", content: "old", revision: "rev-2", size: 3 })
    expect(mocks.open).toHaveBeenCalledWith("rev-2")
    expect(mocks.readFile).toHaveBeenCalledWith("AGENTS.md", { encoding: "utf8" })
    expect(mocks.exists).not.toHaveBeenCalled()
  })
  it.each<Record<string, string>>([{}, { revision: "rev-run" }])("keeps the recorded ref after branch convergence with overrides %j", async (query) => {
    const main = { id: "rev-main", ref: "main", parentId: null, createdAt: "2026-11-07T09:00:00.000Z", files: 2, bytes: 20 }
    const run = { id: "rev-run", ref: "run-1", parentId: null, createdAt: "2026-11-07T10:00:00.000Z", files: 3, bytes: 30 }
    const files = {
      "rev-main": [{ path: "README.md", type: "file", digest: "a" }, { path: "server/old.ts", type: "file", digest: "b" }],
      "rev-run": [{ path: "README.md", type: "file", digest: "a2" }, { path: "server/contact.ts", type: "file", digest: "c" }, { path: ".env", type: "file", digest: "d" }],
    }
    mocks.open.mockImplementation(async (id: "rev-main" | "rev-run") => ({ revision: id === "rev-main" ? main : { ...run, ref: "main" }, list: async () => files[id], stat: mocks.stat, readFile: mocks.readFile }))
    mocks.refs.mockResolvedValue([{ name: "main", head: main }, { name: "run-1", head: run }])
    mocks.list.mockResolvedValue({ revisions: [run] })
    // The Agent mounts no Workspace on this host. The recorded revision is enough.
    mocks.definition.mockReturnValue(undefined)
    mocks.get.mockResolvedValue({ agentName: "coding-agent", observations: [{ attributes: { "vitehub.agent.configuration": { workspace: { name: "meetups", ref: "run-1", revision: "rev-run" } } } }] })
    mocks.useWorkspaceFiles.mockReturnValue({ fs: mocks, history: { refs: mocks.refs, list: mocks.list, open: mocks.open } })
    expect(await handler(request(undefined, query))).toMatchObject({
      base: { ref: "main", revision: "rev-main" },
      changes: [
        { path: "README.md", status: "modified" },
        { path: "server/contact.ts", status: "added" },
        { path: "server/old.ts", status: "deleted" },
      ],
      paths: ["README.md", "server/contact.ts"],
      ref: "run-1",
      repository: "meetups",
      revision: "rev-run",
    })
    expect(mocks.useWorkspaceFiles).toHaveBeenCalledWith("meetups", { mode: "read", refresh: false })
    expect(mocks.list).toHaveBeenCalledWith({ ref: "run-1", limit: 20 })
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it("reads a visible file", async () => {
    expect(await handler(request("AGENTS.md"))).toEqual({ path: "AGENTS.md", content: "test", size: 4, revision: "current" })
    expect(mocks.exists).toHaveBeenCalledWith("AGENTS.md")
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it("returns 404 for a missing file without enumerating other Sources", async () => {
    mocks.exists.mockResolvedValue(false)
    await expect(handler(request("missing.md"))).rejects.toMatchObject({ statusCode: 404, statusMessage: "This file is not in the mounted Workspace." })
    expect(mocks.exists).toHaveBeenCalledWith("missing.md")
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it("rejects directories with the file-selection response", async () => {
    mocks.stat.mockResolvedValue({ type: "directory" })
    await expect(handler(request("src"))).rejects.toMatchObject({ statusCode: 400, statusMessage: "Choose a file to preview." })
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it.each(["exists", "stat", "readFile"] as const)("preserves provider failures from %s", async operation => {
    const error = new Error("Source authorization failed")
    mocks[operation].mockRejectedValue(error)
    await expect(handler(request("AGENTS.md"))).rejects.toBe(error)
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it("includes the source label for a source-backed file", async () => {
    mocks.stat.mockResolvedValue({ type: "file", size: 4, metadata: { source: "repository", private: "hidden" } })
    expect(await handler(request("AGENTS.md"))).toEqual({ path: "AGENTS.md", content: "test", size: 4, revision: "current", provenance: { source: "repository" } })
  })
  it.each([42, { name: "repository" }, null, "", "repo\nname", "repo\0name", "repo\u007fname"])("omits invalid source provenance %j", async source => {
    mocks.stat.mockResolvedValue({ type: "file", size: 4, metadata: { source } })
    expect(await handler(request("AGENTS.md"))).not.toHaveProperty("provenance")
  })
  it.each(["../secret", "/etc/passwd", "repo/../../secret", "repo\\secret", ".env.local", "repo/.git/config", "auth.json"])("rejects unsafe path %s before reading", async path => {
    await expect(handler(request(path))).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it("rejects oversized files before reading", async () => {
    mocks.glob.mockResolvedValue([{ path: "large.txt", type: "file" }])
    mocks.stat.mockResolvedValue({ type: "file", size: 600_000 })
    await expect(handler(request("large.txt"))).rejects.toMatchObject({ statusCode: 413 })
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it("explains missing historical metadata", async () => {
    mocks.get.mockResolvedValue({ agentName: "bot", observations: [] })
    await expect(handler(request())).rejects.toThrow("did not record its Workspace")
  })
  it("does not expose Workspaces for unknown runs", async () => {
    mocks.get.mockResolvedValue(undefined)
    await expect(handler(request())).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.glob).not.toHaveBeenCalled()
  })
})
