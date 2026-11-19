import { describe, expect, it } from "vitest"
import { vitehub, type ViteHubOptions } from "../src/index.ts"

describe("removed vitehub() options", () => {
  it.each([
    ["preset", "cloudflare", "Rename `preset` to `host`."],
    ["sandbox", true, "Rename `sandbox` to `sandboxTask: true`."],
    ["devtools", false, "Remove `devtools`."],
    ["contentImportBase", "vite-hub/content", "Remove `contentImportBase`."],
  ])("fails on `%s` instead of ignoring it", (key, value, fix) => {
    // SAFETY: the test passes an option that ViteHubOptions no longer declares, as an old config does.
    const options = { host: "node", env: false, [key]: value } as ViteHubOptions
    expect(() => vitehub(options)).toThrow(expect.objectContaining({
      code: "VITE_HUB_B0024",
      message: expect.stringContaining(`\`${key}\` in \`vitehub()\` is no longer a ViteHub option.`),
    }))
    expect(() => vitehub(options)).toThrow(fix)
  })

  it("rejects removed secretsFile while accepting Worker vars", () => {
    expect(() => vitehub({ host: "cloudflare", env: false, cloudflare: { vars: true } })).not.toThrow()
    expect(() => vitehub({ host: "cloudflare", env: false, cloudflare: { secretsFile: ".env" } } as ViteHubOptions)).toThrow("Remove `cloudflare.secretsFile`.")
  })

  it("fails on `observability.logs` with the move to `logs`", () => {
    // SAFETY: the test passes an option that ObservabilityOptions no longer declares, as an old config does.
    const options = { host: "node", env: false, observability: { logs: true } } as ViteHubOptions
    expect(() => vitehub(options)).toThrow(expect.objectContaining({
      code: "VITE_HUB_B0024",
      message: expect.stringContaining("Move it to `vitehub({ logs: ... })`."),
    }))
    expect(() => vitehub({ host: "node", env: false, logs: true })).not.toThrow()
  })

  it("accepts `host`", () => {
    expect(() => vitehub({ host: "cloudflare", env: false })).not.toThrow()
  })
})
