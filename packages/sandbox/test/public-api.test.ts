import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { defineSandbox, runSandbox } from "../src/index.ts"

describe("sandbox public api", () => {
  it("keeps the factory surface minimal", async () => {
    const sandboxPackage = await import("../src/index.ts")
    const definition = defineSandbox({
      env: { FOO: "bar" },
      run: async (payload?: { value?: string }) => payload?.value,
      timeout: 1_000,
    })

    expect("createSandbox" in sandboxPackage).toBe(false)
    expect("defineDockerfileFragment" in sandboxPackage).toBe(false)
    expect(definition.options).toEqual({
      env: { FOO: "bar" },
      timeout: 1_000,
    })
  })

  it("keeps the project policy out of runtime Definition options", () => {
    const definition = defineSandbox({
      project: false,
      run: async () => "self-contained",
      timeout: 1_000,
    })

    expect(definition.options).toEqual({ timeout: 1_000 })
    expect(() => defineSandbox({
      project: "auto",
      run: async () => null,
    } as never)).toThrow("project must be a boolean")
  })

  it("returns an error-first tuple instead of throwing", async () => {
    const [error, value] = await runSandbox("missing")

    expect(error?.message).toContain("missing")
    expect(value).toBeUndefined()
  })

  it("emits extensioned provider loader imports for published ESM", async () => {
    const loader = await readFile(join(import.meta.dirname, "../dist/runtime/provider-loader.js"), "utf8")

    expect(loader).toContain('"./providers/cloudflare.js"')
    expect(loader).toContain('"./providers/vercel.js"')
    expect(loader).not.toContain('"./providers/cloudflare"')
    expect(loader).not.toContain('"./providers/vercel"')
    expect(loader).not.toContain("createSandboxClient")
  })

  it("keeps provider implementations internal", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../package.json"), "utf8"))

    expect(manifest.exports).not.toHaveProperty("./runtime/providers/cloudflare")
    expect(manifest.exports).not.toHaveProperty("./runtime/providers/vercel")
    await expect(access(join(import.meta.dirname, "../dist/runtime/providers/cloudflare.js"))).resolves.toBeUndefined()
    await expect(access(join(import.meta.dirname, "../dist/runtime/providers/vercel.js"))).resolves.toBeUndefined()
  })
})
