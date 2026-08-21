import { describe, expect, it, vi } from "vitest"

import { workspaceShell } from "../src/capabilities.ts"
import { setActiveAgentWorkspaceCommands } from "../src/agent-workspace-runtime.ts"

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
  capability: AgentCapabilityDefinition = workspaceShell({ commands: ["agent-browser"], mode: "write" }),
  session = workspaceSession(),
): Promise<{ context: never, session: ReturnType<typeof workspaceSession>, startSession: ReturnType<typeof vi.fn>, tools: AgentToolSet }> {
  if (typeof capability.tools !== "function") throw new Error("workspaceShell capability must expose tool resolver")
  const startSession = vi.fn(async () => session)
  const context = new Map() as never
  const tools = await capability.tools({
    context,
    driver: { kind: "provider" },
    workspace: { startSession, tools: { inspect: () => ({}) } },
    workspaceDefinition: { name: "test" },
  } as never) as AgentToolSet
  return { context, session, startSession, tools } as never
}

describe("workspaceShell capability", () => {
  it("validates configured commands and records workspace requirements", () => {
    expect(workspaceShell({ commands: ["agent-browser", "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"], mode: "write" })).toMatchObject({
      id: "workspace-shell",
      metadata: {
        commands: ["agent-browser", "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"],
        mode: "write",
      },
      mode: "write",
      requires: [{ workspace: { mode: "write", required: true } }],
    })
    expect(workspaceShell({ commands: ["agent-browser"], mode: "write" })).toMatchObject({
      metadata: { mode: "write" },
      requires: [{ workspace: { mode: "write", required: true } }],
    })
    expect(workspaceShell({ commands: "all", mode: "write" })).toMatchObject({
      metadata: { commands: "all", mode: "write" },
      requires: [{ workspace: { mode: "write", required: true } }],
    })
    expect(() => workspaceShell({ commands: [] })).toThrow("requires at least one command")
    expect(() => workspaceShell({ commands: ["pnpm test"] })).toThrow("without whitespace")
    expect(() => workspaceShell({ commands: ["./agent-browser"] })).toThrow("simple executable names or absolute paths")
    expect(() => workspaceShell({ commands: ["agent-browser\n"] })).toThrow("without whitespace")
    expect(() => workspaceShell({ commands: ["agent-browser"] })).toThrow("requires mode: \"write\"")
  })

  it("runs arbitrary structured commands in the Workspace Session", async () => {
    const capability = workspaceShell({ commands: "all", mode: "write", timeout: 5_000 })
    const boxRuntime = await capabilityTools(capability)
    await expect(boxRuntime.tools.workspace_exec!.execute?.({
      args: ["issue", "list"],
      command: "gh",
    })).resolves.toMatchObject({ exitCode: 0 })
    expect(boxRuntime.session.exec).toHaveBeenCalledWith("gh", ["issue", "list"], {
      cwd: "/workspace",
      env: undefined,
      timeout: 5_000,
    })

    await expect(boxRuntime.tools.workspace_exec!.execute?.({
      args: ["-lc", "git status && mktemp"],
      command: "sh",
    })).resolves.toMatchObject({ exitCode: 0 })
    await expect(boxRuntime.tools.workspace_exec!.execute?.({ command: "pnpm test" })).rejects.toThrow(
      "without whitespace/control characters",
    )
  })

  it("gives provider Drivers only explicitly configured commands", async () => {
    const capability = workspaceShell({ commands: ["git"], mode: "write" })
    if (typeof capability.tools !== "function") throw new Error("workspaceShell capability must expose a tool resolver")
    const tools = await capability.tools({
      driver: { kind: "provider" },
      workspace: { startSession: vi.fn(), tools: { inspect: () => ({ workspace_read: {} }) } },
    } as never) as AgentToolSet

    expect(Object.keys(tools)).toEqual(["workspace_exec"])
  })

  it("rejects configured commands for model-backed Drivers", async () => {
    const capability = workspaceShell({ commands: ["git"], mode: "write" })
    if (typeof capability.tools !== "function") throw new Error("workspaceShell capability must expose tool resolver")
    const tools = capability.tools

    expect(() => tools({
      driver: { kind: "model" },
      workspace: { startSession: vi.fn(), tools: { inspect: () => ({}) } },
    } as never)).toThrow("Use sandbox() for model-backed command tools")
  })

  it("runs only allow-listed commands with structured exec options", async () => {
    const command = "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"
    const { session, startSession, tools } = await capabilityTools(workspaceShell({
      commands: [command],
      mode: "write",
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
    expect(session.commit).toHaveBeenCalledWith({ message: "workspace shell command" })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("rejects env overrides that affect command resolution or loading", async () => {
    const { startSession, tools } = await capabilityTools()

    await expect(tools.workspace_exec!.execute?.({
      command: "agent-browser",
      env: { PATH: "/workspace/bin", NODE_OPTIONS: "--require ./loader.js" },
    })).rejects.toThrow("cannot override PATH or loader-related variables")

    expect(startSession).not.toHaveBeenCalled()
  })

  it("rejects a Workspace Session without process authority", async () => {
    const session = Object.assign(workspaceSession(), { executionAuthority: { processes: "none" } })
    const { tools } = await capabilityTools(workspaceShell({ commands: ["agent-browser"], mode: "write" }), session as never)

    await expect(tools.workspace_exec!.execute?.({ command: "agent-browser" })).rejects.toThrow("host that permits processes")
    expect(session.exec).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("runs provider commands through the active hosted Workspace Session", async () => {
    const { context, startSession, tools } = await capabilityTools()
    const exec = vi.fn(async (command: string, args: string[] = []) => ({ args, command, exitCode: 0, stderr: "", stdout: "hosted\n" }))
    const clear = setActiveAgentWorkspaceCommands(context, exec)
    const controller = new AbortController()

    await expect(tools.workspace_exec!.execute?.({ command: "agent-browser" }, { abortSignal: controller.signal })).resolves.toMatchObject({ stdout: "hosted\n" })

    expect(exec).toHaveBeenCalledWith("agent-browser", [], { abortSignal: controller.signal, cwd: "/workspace", env: undefined, timeout: 60_000 })
    expect(startSession).not.toHaveBeenCalled()
    clear()
  })

  it("commits successful write-mode commands", async () => {
    const { session, tools } = await capabilityTools(workspaceShell({ commands: ["agent-browser"], mode: "write" }))

    await expect(tools.workspace_exec!.execute?.({ command: "agent-browser" })).resolves.toMatchObject({ exitCode: 0 })

    expect(session.exec).toHaveBeenCalledWith("agent-browser", [], { cwd: "/workspace", env: undefined, timeout: 60_000 })
    expect(session.commit).toHaveBeenCalledWith({ message: "workspace shell command" })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("does not commit failed commands", async () => {
    const failed = await capabilityTools(workspaceShell({ commands: ["agent-browser"], mode: "write" }), workspaceSession({ exitCode: 2 }))
    await expect(failed.tools.workspace_exec!.execute?.({ command: "agent-browser" })).resolves.toMatchObject({ exitCode: 2 })
    expect(failed.session.commit).not.toHaveBeenCalled()
    expect(failed.session.close).toHaveBeenCalledOnce()
  })

  it("closes the workspace session when execution fails", async () => {
    const session = workspaceSession()
    session.exec.mockRejectedValueOnce(new Error("agent-browser failed"))
    const { tools } = await capabilityTools(workspaceShell({ commands: ["agent-browser"], mode: "write" }), session)

    await expect(tools.workspace_exec!.execute?.({ command: "agent-browser" })).rejects.toThrow("agent-browser failed")

    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("preserves execution and session cleanup failures", async () => {
    const executionError = new Error("agent-browser failed")
    const closeError = new Error("sandbox stop failed")
    const session = workspaceSession()
    session.exec.mockRejectedValueOnce(executionError)
    session.close.mockRejectedValueOnce(closeError)
    const { tools } = await capabilityTools(workspaceShell({ commands: ["agent-browser"], mode: "write" }), session)

    let failure: unknown
    try {
      await tools.workspace_exec!.execute?.({ command: "agent-browser" })
    }
    catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([executionError, closeError])
    expect(session.close).toHaveBeenCalledOnce()
  })
})
