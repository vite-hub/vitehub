import { describe, expect, it } from "vitest"

import { sandboxErrorDiagnostics } from "../src/error-diagnostics.ts"
import { resolveSandbox } from "../src/index.ts"

const fixedCodes = [
  "SANDBOX_R0104",
  "SANDBOX_R0105",
  "SANDBOX_R0106",
  "SANDBOX_R0107",
  "SANDBOX_R0108",
  "SANDBOX_R0109",
  "SANDBOX_R0110",
  "SANDBOX_R0111",
  "SANDBOX_R0112",
  "SANDBOX_R0113",
  "SANDBOX_R0114",
  "SANDBOX_R0115",
  "SANDBOX_R0116",
  "SANDBOX_R0117",
  "SANDBOX_R0118",
  "SANDBOX_R0119",
  "SANDBOX_R0120",
  "SANDBOX_R0121",
  "SANDBOX_R0122",
  "SANDBOX_R0123",
  "SANDBOX_R0124",
  "SANDBOX_R0125",
  "SANDBOX_R0126",
  "SANDBOX_R0127",
  "SANDBOX_R0128",
  "SANDBOX_R0129",
  "SANDBOX_R0130",
  "SANDBOX_R0131",
  "SANDBOX_R0132",
  "SANDBOX_R0133",
  "SANDBOX_R0134",
  "SANDBOX_R0135",
  "SANDBOX_R0136",
  "SANDBOX_R0137",
  "SANDBOX_R0138",
  "SANDBOX_R0139",
  "SANDBOX_R0140",
  "SANDBOX_R0141",
  "SANDBOX_R0142",
  "SANDBOX_R0143",
  "SANDBOX_R0144",
  "SANDBOX_R0145",
  "SANDBOX_R0146",
  "SANDBOX_R0147",
  "SANDBOX_R0148",
  "SANDBOX_R0149",
  "SANDBOX_R0150",
  "SANDBOX_R0151",
  "SANDBOX_R0152",
  "SANDBOX_R0153",
  "SANDBOX_R0154",
  "SANDBOX_R0155",
  "SANDBOX_R0156",
  "SANDBOX_R0159",
  "SANDBOX_R0160",
  "SANDBOX_R0161",
  "SANDBOX_R0162",
  "SANDBOX_R0163",
  "SANDBOX_R0164",
] as const satisfies readonly (keyof typeof sandboxErrorDiagnostics)[]

const namespace = { get: () => ({}), idFromName: () => ({}) }

describe("Sandbox session error fixes", () => {
  it("gives each fixed Sandbox code a fix and its own docs page", () => {
    expect(fixedCodes).toHaveLength(59)
    for (const code of fixedCodes) {
      const error = sandboxErrorDiagnostics[code]({ message: "m" })
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
