import { beforeEach, describe, expect, it, vi } from "vitest"

const readFile = vi.fn()
const tools = vi.fn(() => ({}))
const agentSettings = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock("ai", () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn(count => ({ count })),
  ToolLoopAgent: class {
    constructor(public settings: Record<string, unknown>) {
      agentSettings.push(settings)
    }

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

function context(runtimeConfig: Record<string, unknown> = {}) {
  return {
    input: { messages: [] },
    memo: (_key: string, create: () => unknown) => create(),
    runtime: "nitro",
    runtimeConfig,
    waitUntil: vi.fn(),
  } as never
}

describe("defineAgent workspace option", () => {
  beforeEach(() => {
    agentSettings.length = 0
    readFile.mockReset()
    tools.mockClear()
  })

  it("creates a workspace and agent definition without resolving workspace until run", async () => {
    const { useWorkspace } = await import("@vitehub/workspace")
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      workspace: {
        sources: {},
      },
      description: "Answer from workspace context",
      model: {} as never,
    })

    expect(agent.description).toBe("Answer from workspace context")
    expect(agent.sources).toEqual({})
    expect(useWorkspace).not.toHaveBeenCalled()
  })

  it("uses string instructions", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: "Use workspace sources.",
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.")
  })

  it("joins array instructions", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: [" First ", "", "Second"],
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("First\n\nSecond")
  })

  it("uses callback instructions with workspace fs", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Workspace instructions")
  })

  it("passes runtime context and workspace to callback instructions", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent<{ vertex: { model: string } }>({
      workspace: {},
      instructions: ({ fs, runtimeConfig, workspace }) => {
        expect(fs).toBe(workspace.fs)
        expect(runtimeConfig).toEqual({ vertex: { model: "gemini" } })
        return runtimeConfig.vertex.model
      },
      model: {} as never,
    }), { workspace: "docs" })

    await agent.run!(context({ vertex: { model: "gemini" } }))

    expect(agentSettings.at(-1)?.instructions).toBe("gemini")
  })

  it("defaults instructions to AGENTS.md when inferred by discovery", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { instructionsFile: "AGENTS.md", workspace: "docs" })

    await agent.run!(context())

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Workspace instructions")
  })

  it("ignores missing implicit AGENTS.md", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"))
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      model: {} as never,
    }), { instructionsFile: "AGENTS.md", workspace: "docs" })

    await agent.run!(context())

    expect(agentSettings.at(-1)?.instructions).toBe("")
  })

  it("throws when explicit callback instructions fail", async () => {
    readFile.mockRejectedValueOnce(new Error("missing"))
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")

    const agent = withWorkspaceAgentDefaults(defineAgent({
      workspace: {},
      instructions: ({ fs }) => fs.readFile("MISSING.md"),
      model: {} as never,
    }), { instructionsFile: "AGENTS.md", workspace: "docs" })

    await expect(agent.run!(context())).rejects.toThrow("missing")
  })
})
