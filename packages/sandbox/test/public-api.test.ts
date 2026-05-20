import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { defineSandbox, runSandbox } from "../src/index.ts"

describe("sandbox public api", () => {
  it("keeps the factory surface minimal", async () => {
    const sandboxPackage = await import("../src/index.ts")
    const definition = defineSandbox(async (payload?: { value?: string }) => payload?.value, {
      env: { FOO: "bar" },
      runtime: { command: "node", args: ["--trace-warnings"] },
      timeout: 1_000,
    })

    expect("createSandbox" in sandboxPackage).toBe(false)
    expect(definition.options).toEqual({
      env: { FOO: "bar" },
      runtime: { command: "node", args: ["--trace-warnings"] },
      timeout: 1_000,
    })
  })

  it("returns a result wrapper instead of throwing", async () => {
    const result = await runSandbox("missing")

    expect(result.isErr()).toBe(true)
    expect(result.isOk()).toBe(false)
    if (result.isErr()) {
      expect(result.error!.message).toContain("missing")
    }
  })

  it("emits extensioned provider loader imports for published ESM", async () => {
    const loader = await readFile(join(import.meta.dirname, "../dist/runtime/provider-loader.js"), "utf8")

    expect(loader).toContain('"./providers/cloudflare.js"')
    expect(loader).toContain('"../sandbox/providers/cloudflare.js"')
    expect(loader).toContain('"./providers/vercel.js"')
    expect(loader).toContain('"../sandbox/providers/vercel.js"')
    expect(loader).not.toContain('"./providers/cloudflare"')
    expect(loader).not.toContain('"../sandbox/providers/cloudflare"')
    expect(loader).not.toContain('"./providers/vercel"')
    expect(loader).not.toContain('"../sandbox/providers/vercel"')
  })
})
