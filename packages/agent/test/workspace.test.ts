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

describe("defineWorkspaceAgent", () => {
  beforeEach(() => {
    agentSettings.length = 0
    readFile.mockReset()
    tools.mockClear()
  })

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

  it("uses string instructions", async () => {
    const { defineWorkspaceAgent } = await import("../src/workspace.ts")

    const agent = defineWorkspaceAgent({
      instructions: "Use workspace sources.",
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

    expect(agentSettings.at(-1)?.instructions).toBe("Use workspace sources.")
  })

  it("joins array instructions", async () => {
    const { defineWorkspaceAgent } = await import("../src/workspace.ts")

    const agent = defineWorkspaceAgent({
      instructions: [" First ", "", "Second"],
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

    expect(agentSettings.at(-1)?.instructions).toBe("First\n\nSecond")
  })

  it("uses callback instructions with workspace fs", async () => {
    readFile.mockResolvedValueOnce("Workspace instructions")
    const { defineWorkspaceAgent } = await import("../src/workspace.ts")

    const agent = defineWorkspaceAgent({
      instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
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

    expect(readFile).toHaveBeenCalledWith("AGENTS.md")
    expect(agentSettings.at(-1)?.instructions).toBe("Workspace instructions")
  })

  it("passes runtime context and workspace to callback instructions", async () => {
    const { defineWorkspaceAgent } = await import("../src/workspace.ts")

    const agent = defineWorkspaceAgent<{ vertex: { model: string } }>({
      instructions: ({ fs, runtimeConfig, workspace }) => {
        expect(fs).toBe(workspace.fs)
        expect(runtimeConfig).toEqual({ vertex: { model: "gemini" } })
        return runtimeConfig.vertex.model
      },
      model: {} as never,
      workspace: "docs",
    })

    await agent.run!({
      input: { messages: [] },
      memo: (_key: string, create: () => unknown) => create(),
      runtime: "nitro",
      runtimeConfig: { vertex: { model: "gemini" } },
      waitUntil: vi.fn(),
    } as never)

    expect(agentSettings.at(-1)?.instructions).toBe("gemini")
  })

  it("still uses AGENTS.md when deprecated instructionsFile is true", async () => {
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
    expect(agentSettings.at(-1)?.instructions).toBe("Workspace instructions")
  })
})
