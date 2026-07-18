import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { defineSandbox, runSandbox, SandboxError } from "../src/index.ts"

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
    const secret = "missing?token=vh_secret_123"
    const result = await runSandbox(secret)

    expect(result.isErr()).toBe(true)
    expect(result.isOk()).toBe(false)
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(SandboxError)
      expect(result.error).toMatchObject({ code: "SANDBOX_NOT_FOUND", message: "Sandbox definition was not found." })
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  it("publishes the ViteHub-owned error contract without Effect or Better Result", async () => {
    const dist = join(import.meta.dirname, "../dist")
    const declarationFiles = (await readdir(dist)).filter(file => file.endsWith(".d.ts"))
    const declarations = (await Promise.all(declarationFiles.map(file => readFile(join(dist, file), "utf8")))).join("\n")
    const [bundle, packageJson] = await Promise.all([
      readFile(join(dist, "index.js"), "utf8"),
      readFile(join(import.meta.dirname, "../package.json"), "utf8"),
    ])

    expect(declarations).toContain("class SandboxError extends ViteHubError")
    expect(declarations).toContain("type SandboxErrorJSON")
    expect(declarations).not.toMatch(/from ["']effect(?:\/[^"']*)?["']/)
    expect(bundle).not.toContain("better-result")
    expect(bundle).not.toContain("FiberFailure")
    expect(packageJson).not.toContain('"better-result"')
    expect(packageJson).not.toContain('"effect"')
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
