import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ inspector: vi.fn(), get: vi.fn(), definition: vi.fn(), glob: vi.fn(), exists: vi.fn(), stat: vi.fn(), readFile: vi.fn(), useWorkspace: vi.fn() }))
vi.mock("@vite-hub/agent/server", () => ({ agentHostWorkspaceRoute: "/api/_vitehub/console/invocations/:id/workspace", getAgentHostWorkspaceInspector: mocks.inspector }))
vi.mock("../src/console/runtime/server/invocations.ts", () => ({ getConsoleInvocations: () => ({ get: mocks.get }) }))
vi.mock("../src/console/runtime/server/agents.ts", () => ({ getConsoleAgentDefinition: mocks.definition }))
vi.mock("@vite-hub/workspace/runtime", () => ({ useWorkspace: mocks.useWorkspace }))
import handler from "../src/console/runtime/server/invocation-workspace.get.ts"
const request = (path?: string) => ({ method: "GET", context: { params: { id: "run" } }, req: { url: `http://localhost/api/_vitehub/console/invocations/run/workspace${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}` } })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.useWorkspace.mockReturnValue({ fs: mocks })
  mocks.get.mockResolvedValue({ agentName: "bot", observations: [{ attributes: { "vitehub.agent.configuration": { workspace: { name: "bot" } } } }] })
  mocks.definition.mockReturnValue({ workspace: { name: "bot" } })
  mocks.glob.mockResolvedValue([{ path: "AGENTS.md", type: "file" }, { path: ".env", type: "file" }, { path: "repo/.git/config", type: "file" }, { path: "src", type: "directory" }])
  mocks.exists.mockResolvedValue(true)
  mocks.stat.mockResolvedValue({ type: "file", size: 4 })
  mocks.readFile.mockResolvedValue("test")
})
describe("invocation Workspace inspection", () => {
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
  it("passes the file path to the configured host inspector", async () => {
    const file = { content: "test", path: "src/a b.ts", revision: "abc123", size: 4 }
    const inspect = vi.fn(async () => Response.json(file))
    mocks.inspector.mockReturnValue(inspect)
    expect(await handler(request(file.path))).toEqual(file)
    expect(inspect).toHaveBeenCalledWith("run", file.path)
  })
  it.each([403, 404, 422])("preserves host inspection failure %i without falling back to mounted files", async status => {
    mocks.inspector.mockReturnValue(async () => new Response("Snapshot unavailable", { status }))
    await expect(handler(request())).rejects.toMatchObject({ statusCode: status, statusMessage: "Snapshot unavailable" })
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it("identifies current mounted files without claiming a historical snapshot", async () => {
    expect(await handler(request())).toEqual({ paths: ["AGENTS.md"], repository: "bot", revision: "current" })
    expect(mocks.definition).toHaveBeenCalledWith("bot", "inspect")
    expect(mocks.useWorkspace).toHaveBeenCalledWith("bot", { mode: "read" })
  })
  it("reads a visible file", async () => {
    expect(await handler(request("AGENTS.md"))).toEqual({ path: "AGENTS.md", content: "test", size: 4, revision: "current" })
    expect(mocks.glob).not.toHaveBeenCalled()
  })
  it("reports a missing file without stat or listing the Workspace", async () => {
    mocks.exists.mockResolvedValue(false)
    mocks.stat.mockRejectedValue(new Error("[vitehub] Workspace path does not exist: missing.md."))
    await expect(handler(request("missing.md"))).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.glob).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
  })
  it("preserves Workspace failures during the existence check", async () => {
    const error = new Error("Source unavailable")
    mocks.exists.mockRejectedValue(error)
    await expect(handler(request("AGENTS.md"))).rejects.toBe(error)
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it.each(["portal", "docs:api", "org/repo", "../source", "日本語", "a".repeat(101)])("reports mounted source provenance %s as display text", async source => {
    mocks.glob.mockResolvedValue([{ path: ".agents/skills/perf/SKILL.md", type: "file" }])
    mocks.stat.mockResolvedValue({ type: "file", size: 4, metadata: { source } })
    expect(await handler(request(".agents/skills/perf/SKILL.md"))).toEqual({
      path: ".agents/skills/perf/SKILL.md",
      content: "test",
      provenance: { source },
      size: 4,
      revision: "current",
    })
  })
  it.each([null, 42, {}, "", "source\u0000key", "source\nkey"])("omits invalid source provenance %j while preserving the file preview", async source => {
    mocks.stat.mockResolvedValue({ type: "file", size: 4, metadata: { source } })
    expect(await handler(request("AGENTS.md"))).toEqual({ path: "AGENTS.md", content: "test", size: 4, revision: "current" })
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
