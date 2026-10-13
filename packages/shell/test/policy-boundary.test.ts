import { describe, expect, it } from "vitest"

import { createShellRuntime } from "../src/index.ts"

import type { ShellExecutionProvider } from "../src/index.ts"

const provider: ShellExecutionProvider = {
  boundary: {
    cwd: true,
    env: true,
    filesystem: { writable: false },
    network: false,
    processes: { background: false, interactive: false },
    streaming: false,
    timeout: { enforcedBy: "provider", supported: true },
  },
  async exec(command) {
    return { command, event: "command_finished", exitCode: 0, stderr: "", stdout: "ok" }
  },
}

describe("shell runtime policy boundaries", () => {
  it("does not inherit policy limits from a prototype", async () => {
    const policy = Object.create({ maxShellCalls: 0 }) as { maxShellCalls?: number }
    const runtime = createShellRuntime({ provider, policy })

    await expect(runtime.exec("echo ok")).resolves.toMatchObject({
      event: "command_finished",
      stdout: "ok",
    })
  })

  it("snapshots policy values when the runtime is created", async () => {
    const policy = { maxShellCalls: 1 }
    const runtime = createShellRuntime({ provider, policy })
    policy.maxShellCalls = 0

    await expect(runtime.exec("echo ok")).resolves.toMatchObject({
      event: "command_finished",
      stdout: "ok",
    })
  })
})
