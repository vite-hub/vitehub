import { describe, expect, it, vi } from "vitest"

vi.mock("@vitehub/workspace", () => ({
  useWorkspace: vi.fn(),
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
})
