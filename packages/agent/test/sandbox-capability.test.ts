import { describe, expect, it, vi } from "vitest"

import { sandbox } from "../src/capabilities.ts"

import type { AgentCapabilityDefinition, AgentToolSet } from "../src/types.ts"

async function capabilityTools(
  capability: AgentCapabilityDefinition,
  exec: ReturnType<typeof vi.fn>,
): Promise<AgentToolSet> {
  if (typeof capability.tools !== "function") throw new Error("sandbox capability must expose a tool resolver")
  return await capability.tools({
    capabilities: { sandbox: { kind: "sandbox", value: { exec } } },
    workspace: {},
  } as never) as AgentToolSet
}

describe("sandbox capability", () => {
  it("copies and freezes the command allowlist", async () => {
    const commands = ["node"]
    const capability = sandbox({ commands })
    commands.push("sh")

    expect(capability.metadata).toEqual({ commands: ["node"] })
    expect(Object.isFrozen(capability.metadata?.commands)).toBe(true)

    const exec = vi.fn(async () => ({ code: 0, ok: true, stderr: "", stdout: "" }))
    const tools = await capabilityTools(capability, exec)
    expect(tools.sandbox_exec?.inputSchema).toMatchObject({
      properties: { command: { enum: ["node"] } },
    })
    return expect(tools.sandbox_exec?.execute?.({ command: "sh" })).rejects.toThrow("not allowed")
  })

  it("validates structured execution options", async () => {
    const exec = vi.fn(async () => ({ code: 0, ok: true, stderr: "", stdout: "ok" }))
    const tools = await capabilityTools(sandbox({ commands: ["node"] }), exec)

    await expect(tools.sandbox_exec?.execute?.({ command: "node", args: "--version" })).rejects.toThrow("args must be an array")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", env: { PATH: "/tmp" } })).rejects.toThrow("cannot override PATH")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", env: { NODE_OPTIONS: "--require loader" } })).rejects.toThrow("cannot override PATH")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", env: { LD_PRELOAD: "loader.so" } })).rejects.toThrow("cannot override PATH")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", timeout: 0 })).rejects.toThrow("timeout must be a positive number")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", timeout: 2_147_483_648 })).rejects.toThrow("timeout must be a positive number")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", cwd: 42 })).rejects.toThrow("cwd must be a string")

    await expect(tools.sandbox_exec?.execute?.({
      args: ["--version"],
      command: "node",
      cwd: "provider://workspace/project",
      env: { NO_COLOR: "1" },
      timeout: 5_000,
    })).resolves.toEqual({ code: 0, ok: true, stderr: "", stdout: "ok" })
    expect(exec).toHaveBeenCalledWith("node", ["--version"], {
      cwd: "provider://workspace/project",
      env: { NO_COLOR: "1" },
      timeout: 5_000,
    })
  })

  it("forwards tool cancellation to the sandbox primitive", async () => {
    const exec = vi.fn(async () => ({ code: 0, ok: true, stderr: "", stdout: "" }))
    const tools = await capabilityTools(sandbox({ commands: ["node"] }), exec)
    const controller = new AbortController()

    await tools.sandbox_exec?.execute?.({ command: "node" }, { abortSignal: controller.signal })

    expect(exec).toHaveBeenCalledWith("node", [], { signal: controller.signal })
  })
})
