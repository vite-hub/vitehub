import { describe, expect, it } from "vitest"

import { sandboxErrorDiagnostics } from "../src/error-diagnostics.ts"
import { resolveSandbox, type SandboxRuntime } from "../src/index.ts"

const fixedCodes = [
  "SANDBOX_R0020",
  "SANDBOX_R0022",
  "SANDBOX_R0023",
  "SANDBOX_R0024",
  "SANDBOX_R0025",
  "SANDBOX_R0026",
  "SANDBOX_R0027",
  "SANDBOX_R0028",
  "SANDBOX_R0029",
  "SANDBOX_R0030",
  "SANDBOX_R0031",
  "SANDBOX_R0032",
  "SANDBOX_R0033",
  "SANDBOX_R0034",
  "SANDBOX_R0035",
  "SANDBOX_R0036",
  "SANDBOX_R0037",
  "SANDBOX_R0038",
  "SANDBOX_R0039",
  "SANDBOX_R0040",
  "SANDBOX_R0041",
  "SANDBOX_R0042",
  "SANDBOX_R0043",
  "SANDBOX_R0044",
  "SANDBOX_R0045",
  "SANDBOX_R0046",
  "SANDBOX_R0047",
  "SANDBOX_R0048",
  "SANDBOX_R0049",
  "SANDBOX_R0050",
  "SANDBOX_R0051",
  "SANDBOX_R0052",
  "SANDBOX_R0053",
  "SANDBOX_R0054",
  "SANDBOX_R0055",
  "SANDBOX_R0056",
  "SANDBOX_R0057",
  "SANDBOX_R0058",
  "SANDBOX_R0059",
  "SANDBOX_R0060",
  "SANDBOX_R0061",
  "SANDBOX_R0062",
  "SANDBOX_R0063",
  "SANDBOX_R0064",
  "SANDBOX_R0088",
  "SANDBOX_R0090",
  "SANDBOX_R0091",
  "SANDBOX_R0092",
  "SANDBOX_R0093",
  "SANDBOX_R0094",
  "SANDBOX_R0095",
  "SANDBOX_R0096",
  "SANDBOX_R0097",
  "SANDBOX_R0098",
  "SANDBOX_R0100",
  "SANDBOX_R0101",
  "SANDBOX_R0102",
  "SANDBOX_R0103",
] as const satisfies readonly (keyof typeof sandboxErrorDiagnostics)[]

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
      const error = sandboxErrorDiagnostics[code]({ message: "m", retryable: undefined })
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
