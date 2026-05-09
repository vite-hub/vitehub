import { describe, expect, it, vi } from "vitest"

const readFile = vi.fn()
const tools = vi.fn(() => ({}))

vi.mock("ai", () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn(count => ({ count })),
  ToolLoopAgent: class {
    constructor(public settings: Record<string, unknown>) {}

    async generate() {
      return { finishReason: "stop", text: "ok" }
    }
  },
}))

vi.mock("@vitehub/workspace", () => ({
  useWorkspace: vi.fn(() => ({
    fs: { readFile },
    tools,
  })),
}))

describe("defineWorkspaceAgent", () => {
  it("creates an agent definition without resolving workspace until run", async () => {
    const { useWorkspace } = await import("@vitehub/workspace")
    const { defineWorkspaceAgent } = await import("../src/workspace.ts")

    const agent = defineWorkspaceAgent({
      description: "Answer from workspace context",
      model: {} as never,
      workspace: "docs",
    })

    expect(agent.description).toBe("Answer from workspace context")
    expect(useWorkspace).not.toHaveBeenCalled()
  })

  it("uses AGENTS.md when instructionsFile is true", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineWorkspaceAgent } = await import("../src/workspace.ts")

    const agent = defineWorkspaceAgent({
      instructionsFile: true,
      model: {} as never,
      workspace: "docs",
    })

    await agent.run!({
      input: { messages: [] },
      memo: (_key: string, create: () => unknown) => create(),
      runtime: "nitro",
      runtimeConfig: {},
      waitUntil: vi.fn(),
    } as never)

    expect(readFile).toHaveBeenCalledWith("AGENTS.md", { encoding: "utf8" })
  })
})
