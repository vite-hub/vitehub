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
      properties: { command: { enum: ["node"] }, timeout: { type: "integer" } },
    })
    return expect(tools.sandbox_exec?.execute?.({ command: "sh" })).rejects.toThrow("not allowed")
  })

  it("validates structured execution options", async () => {
    const exec = vi.fn(async () => ({ code: 0, ok: true, stderr: "", stdout: "ok" }))
    const tools = await capabilityTools(sandbox({ commands: ["node"] }), exec)
    const sparseArgs: string[] = []
    sparseArgs.length = 1

    await expect(tools.sandbox_exec?.execute?.({ command: "node", args: "--version" })).rejects.toThrow("args must be an array")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", args: sparseArgs })).rejects.toThrow("args must be an array")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", env: { PATH: "/tmp" } })).rejects.toThrow("cannot override PATH")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", env: { NODE_OPTIONS: "--require loader" } })).rejects.toThrow("cannot override PATH")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", env: { LD_PRELOAD: "loader.so" } })).rejects.toThrow("cannot override PATH")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", timeout: 0 })).rejects.toThrow("timeout must be a positive integer")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", timeout: 0.5 })).rejects.toThrow("timeout must be a positive integer")
    await expect(tools.sandbox_exec?.execute?.({ command: "node", timeout: 2_147_483_648 })).rejects.toThrow("timeout must be a positive integer")
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

    const args = ["--version", "--inspect"]
    Object.defineProperty(args, 1, {
      configurable: true,
      get() {
        return "--inspect"
      },
    })
    await tools.sandbox_exec?.execute?.({ command: "node", args })
    expect(exec).toHaveBeenLastCalledWith("node", ["--version", "--inspect"], {})

    let reportedLength = 0
    const unstableArgs = new Proxy(Array.from({ length: 129 }, () => "--version"), {
      get(target, property, receiver) {
        if (property === "length") return reportedLength++ === 0 ? 1 : target.length
        return Reflect.get(target, property, receiver)
      },
    })
    await tools.sandbox_exec?.execute?.({ command: "node", args: unstableArgs })
    expect(exec).toHaveBeenLastCalledWith("node", ["--version"], {})

    const env: Record<string, string> = {}
    Object.defineProperty(env, "NO_COLOR", {
      configurable: true,
      enumerable: true,
      get() {
        env.LATE = "ignored"
        return "1"
      },
    })
    await tools.sandbox_exec?.execute?.({ command: "node", env })
    expect(exec).toHaveBeenLastCalledWith("node", [], { env: { NO_COLOR: "1" } })
  })

  it("forwards tool cancellation to the sandbox primitive", async () => {
    const exec = vi.fn(async () => ({ code: 0, ok: true, stderr: "", stdout: "" }))
    const tools = await capabilityTools(sandbox({ commands: ["node"] }), exec)
    const controller = new AbortController()

    await tools.sandbox_exec?.execute?.({ command: "node" }, { abortSignal: controller.signal })

    expect(exec).toHaveBeenCalledWith("node", [], { signal: controller.signal })
  })
})
