import { describe, expect, it } from "vitest"

import { sandboxErrorDiagnostics } from "../src/error-diagnostics.ts"
import { resolveSandbox } from "../src/index.ts"

const fixedCodes = [
  ...range(104, 156),
  ...range(159, 164),
] as const

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => `SANDBOX_R${String(from + index).padStart(4, "0")}`)
}

const namespace = { get: () => ({}), idFromName: () => ({}) }

describe("Sandbox session error fixes", () => {
  it("gives each fixed Sandbox code a fix and its own docs page", () => {
    expect(fixedCodes).toHaveLength(59)
    for (const code of fixedCodes) {
      const error = sandboxErrorDiagnostics[code as Exclude<keyof typeof sandboxErrorDiagnostics, "SANDBOX_R0165">]({ message: "m", retryable: undefined })
      expect(error.fix, code).toMatch(/\S/)
      expect(error.docs, code).toBe(`https://vitehub.dev/docs/sandbox/diagnostics/${code.toLowerCase()}`)
    }
  })

  it("tells a Cloudflare Sandbox to drop the host cwd", async () => {
    await expect(resolveSandbox({ cwd: "/tmp", runtime: { kind: "cloudflare", namespace: namespace as never } }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0122",
      fix: expect.stringContaining("Remove `cwd`"),
    })
  })

  it("names the runtimes that keep Home state", async () => {
    await expect(resolveSandbox({
      home: { state: { ".codex": { key: "codex" } } },
      runtime: { kind: "cloudflare", namespace: namespace as never },
    }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0123",
      fix: expect.stringContaining("`home.state`"),
    })
  })

  it("asks the trusted-host runtime for an absolute stateRoot", async () => {
    await expect(resolveSandbox({
      home: { state: { ".codex": { key: "codex" } } },
      runtime: "trusted-host",
    }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0130",
      fix: expect.stringContaining("`runtime.stateRoot`"),
    })
  })

  it("lists the toolchain keys for an unknown key", async () => {
    await expect(resolveSandbox({
      runtime: "trusted-host",
      toolchain: { bun: "1" } as never,
    }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0146",
      fix: expect.stringContaining("`packageManager`"),
    })
  })
})
