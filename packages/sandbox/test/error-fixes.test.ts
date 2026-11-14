import { describe, expect, it } from "vitest"

import { sandboxErrorDiagnostics } from "../src/error-diagnostics.ts"
import { resolveSandbox, type SandboxRuntime } from "../src/index.ts"

const fixedCodes = [
  "SANDBOX_R0020",
  ...range(22, 64),
  "SANDBOX_R0088",
  "SANDBOX_R0090",
  ...range(91, 98),
  ...range(100, 103),
] as const

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => `SANDBOX_R${String(from + index).padStart(4, "0")}`)
}

const runtime: SandboxRuntime = {
  name: "probe",
  async prepare(input) {
    return {
      cache: { state: "disposable" },
      environment: { env: {} },
      executionAuthority: {
        credentials: "none",
        environment: "selected",
        filesystem: { access: "none", scope: "sandbox" },
        isolation: "container",
        network: "none",
        processes: "none",
      },
      identity: input.identity,
      requirements: input.requirements,
      runtime: "probe",
      workspace: { state: "disposable" },
    }
  },
  async open() {
    throw new Error("unused")
  },
}

describe("Sandbox error fixes", () => {
  it("gives each fixed Sandbox code a fix and its own docs page", () => {
    expect(fixedCodes).toHaveLength(58)
    for (const code of fixedCodes) {
      const error = sandboxErrorDiagnostics[code as Exclude<keyof typeof sandboxErrorDiagnostics, "SANDBOX_R0165">]({ message: "m", retryable: undefined })
      expect(error.fix, code).toMatch(/\S/)
      expect(error.docs, code).toBe(`https://vitehub.dev/docs/sandbox/diagnostics/${code.toLowerCase()}`)
    }
  })

  it("names the built-in runtimes for an unknown runtime name", async () => {
    await expect(resolveSandbox({ runtime: "trusted_host" as never }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0031",
      fix: expect.stringContaining("`\"trusted-host\"`"),
    })
  })

  it("tells the caller to remove cwd or checkout", async () => {
    await expect(resolveSandbox({
      checkout: { ref: "main", remote: "https://example.com/repo.git", sha: "a".repeat(40) },
      cwd: "/tmp",
      runtime,
    }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0035",
      fix: expect.stringContaining("Remove `cwd` or `checkout`"),
    })
  })

  it("tells the caller how to name an env variable", async () => {
    await expect(resolveSandbox({ env: { "GH-TOKEN": "x" }, runtime }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0039",
      fix: expect.stringContaining("`env` key"),
    })
  })

  it("asks for the full checkout sha", async () => {
    await expect(resolveSandbox({
      checkout: { ref: "main", remote: "https://example.com/repo.git", sha: "abc123" },
      runtime,
    }, {})).rejects.toMatchObject({
      code: "SANDBOX_R0064",
      fix: expect.stringContaining("`checkout.sha`"),
    })
  })
})
