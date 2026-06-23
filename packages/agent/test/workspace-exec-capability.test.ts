import { describe, expect, it, vi } from "vitest"

import { workspaceExec } from "../src/capabilities.ts"

import type { AgentCapabilityDefinition, AgentToolSet } from "../src/types.ts"
import type { WorkspaceSession } from "@vite-hub/workspace"

function workspaceSession(options: { exitCode?: number } = {}) {
  return {
    close: vi.fn(),
    commit: vi.fn(),
    exec: vi.fn(async (command: string, args: string[] = []) => ({
      args,
      command,
      exitCode: options.exitCode ?? 0,
      stderr: "",
      stdout: "ok\n",
    })),
  } as unknown as WorkspaceSession & {
    close: ReturnType<typeof vi.fn>
    commit: ReturnType<typeof vi.fn>
    exec: ReturnType<typeof vi.fn>
  }
}

async function capabilityTools(
  capability: AgentCapabilityDefinition = workspaceExec({ commands: ["agent-browser"] }),
  session = workspaceSession(),
): Promise<{ session: ReturnType<typeof workspaceSession>, startSession: ReturnType<typeof vi.fn>, tools: AgentToolSet }> {
  if (typeof capability.tools !== "function") throw new Error("workspaceExec capability must expose tool resolver")
  const startSession = vi.fn(async () => session)
  const tools = await capability.tools({ workspace: { startSession } } as never) as AgentToolSet
  return { session, startSession, tools }
}

describe("workspaceExec capability", () => {
  it("validates configured commands and records workspace requirements", () => {
    expect(workspaceExec({ commands: ["agent-browser", "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"] })).toMatchObject({
      id: "workspace-exec",
      metadata: {
        commands: ["agent-browser", "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"],
        mode: "read",
      },
      mode: "read",
      requires: [{ workspace: { mode: "write", required: true } }],
    })
    expect(workspaceExec({ commands: ["agent-browser"], mode: "write" })).toMatchObject({
      metadata: { mode: "write" },
      requires: [{ workspace: { mode: "write", required: true } }],
    })
    expect(() => workspaceExec({ commands: [] })).toThrow("requires at least one command")
    expect(() => workspaceExec({ commands: ["pnpm test"] })).toThrow("without whitespace")
    expect(() => workspaceExec({ commands: ["./agent-browser"] })).toThrow("simple executable names or absolute paths")
    expect(() => workspaceExec({ commands: ["agent-browser\n"] })).toThrow("without whitespace")
  })

  it("runs only allow-listed commands with structured exec options", async () => {
    const command = "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"
    const { session, startSession, tools } = await capabilityTools(workspaceExec({
      commands: [command],
      timeout: 5_000,
    }))

    await expect(tools.workspace_exec!.execute?.({
      args: ["screenshot", "--output", "artifacts/browser.png"],
      command,
      cwd: "artifacts",
      env: { NO_COLOR: "1" },
      timeout: 1_000,
    })).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" })
    await expect(tools.workspace_exec!.execute?.({ command: "bash" })).rejects.toThrow("not allowed")

    expect(startSession).toHaveBeenCalledOnce()
    expect(session.exec).toHaveBeenCalledWith(command, ["screenshot", "--output", "artifacts/browser.png"], {
      cwd: "/workspace/artifacts",
      env: { NO_COLOR: "1" },
      timeout: 1_000,
    })
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("commits successful write-mode commands", async () => {
    const { session, tools } = await capabilityTools(workspaceExec({ commands: ["agent-browser"], mode: "write" }))

    await expect(tools.workspace_exec!.execute?.({ command: "agent-browser" })).resolves.toMatchObject({ exitCode: 0 })

    expect(session.exec).toHaveBeenCalledWith("agent-browser", [], { cwd: "/workspace", env: undefined, timeout: undefined })
    expect(session.commit).toHaveBeenCalledWith({ message: "workspace exec" })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("does not commit read-mode or failed commands", async () => {
    const read = await capabilityTools(workspaceExec({ commands: ["agent-browser"] }))
    await expect(read.tools.workspace_exec!.execute?.({ command: "agent-browser" })).resolves.toMatchObject({ exitCode: 0 })
    expect(read.session.commit).not.toHaveBeenCalled()
    expect(read.session.close).toHaveBeenCalledOnce()

    const failed = await capabilityTools(workspaceExec({ commands: ["agent-browser"], mode: "write" }), workspaceSession({ exitCode: 2 }))
    await expect(failed.tools.workspace_exec!.execute?.({ command: "agent-browser" })).resolves.toMatchObject({ exitCode: 2 })
    expect(failed.session.commit).not.toHaveBeenCalled()
    expect(failed.session.close).toHaveBeenCalledOnce()
  })

  it("closes the workspace session when execution fails", async () => {
    const session = workspaceSession()
    session.exec.mockRejectedValueOnce(new Error("agent-browser failed"))
    const { tools } = await capabilityTools(workspaceExec({ commands: ["agent-browser"], mode: "write" }), session)

    await expect(tools.workspace_exec!.execute?.({ command: "agent-browser" })).rejects.toThrow("agent-browser failed")

    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })
})
