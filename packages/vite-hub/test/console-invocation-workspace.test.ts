import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ get: vi.fn(), definition: vi.fn(), glob: vi.fn(), stat: vi.fn(), readFile: vi.fn() }))
vi.mock("../src/console/runtime/server/invocations.ts", () => ({ getConsoleInvocations: () => ({ get: mocks.get }) }))
vi.mock("../src/console/runtime/server/agents.ts", () => ({ getConsoleAgentDefinition: mocks.definition }))
vi.mock("@vite-hub/workspace/runtime", () => ({ useWorkspace: () => ({ fs: mocks }) }))
import handler from "../src/console/runtime/server/invocation-workspace.get.ts"
const request = (path?: string) => ({ method: "GET", context: { params: { id: "run" } }, req: { url: `http://localhost/api/_vitehub/console/invocations/run/workspace${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}` } })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.get.mockResolvedValue({ agentName: "bot", observations: [{ attributes: { "vitehub.agent.configuration": { workspace: { name: "bot" } } } }] })
  mocks.definition.mockReturnValue({ workspace: { name: "bot" } })
  mocks.glob.mockResolvedValue([{ path: "AGENTS.md", type: "file" }, { path: ".env", type: "file" }, { path: "repo/.git/config", type: "file" }, { path: "src", type: "directory" }])
  mocks.stat.mockResolvedValue({ type: "file", size: 4 })
  mocks.readFile.mockResolvedValue("test")
})
describe("invocation Workspace inspection", () => {
  it("identifies current mounted files without claiming a historical snapshot", async () => {
    expect(await handler(request())).toEqual({ paths: ["AGENTS.md"], repository: "bot", revision: "current" })
    expect(mocks.definition).toHaveBeenCalledWith("bot", "inspect")
  })
  it("reads a visible file", async () => {
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
