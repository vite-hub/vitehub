import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { defineSandbox, NotSupportedError, runSandbox, SandboxError } from "../src/index.ts"

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

  it("exports the structured error contract", () => {
    expect(new SandboxError({ code: "SANDBOX_RUNTIME_ERROR", message: "failed" })).toBeInstanceOf(
      Error,
    )
    expect(new NotSupportedError("snapshot", "vercel")).toBeInstanceOf(SandboxError)
  })

  it("returns a result wrapper instead of throwing", async () => {
    const secret = "missing?token=vh_secret_123"
    const result = await runSandbox(secret)

    expect(result.isErr()).toBe(true)
    expect(result.isOk()).toBe(false)
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        code: "SANDBOX_NOT_FOUND",
        message: "Sandbox definition was not found.",
      })
      expect(JSON.stringify(result.error)).not.toContain(secret)
    }
  })

  it("publishes the ViteHub-owned error contract without Effect or Better Result", async () => {
    const dist = join(import.meta.dirname, "../dist")
    const artifactFiles = await readdir(dist, { recursive: true })
    const declarationFiles = artifactFiles.filter(file => file.endsWith(".d.ts"))
    const javascriptFiles = artifactFiles.filter(file => file.endsWith(".js"))
    const declarations = (await Promise.all(declarationFiles.map(file => readFile(join(dist, file), "utf8")))).join("\n")
    const [javascript, packageJson] = await Promise.all([
      Promise.all(javascriptFiles.map(file => readFile(join(dist, file), "utf8"))).then(files => files.join("\n")),
      readFile(join(import.meta.dirname, "../package.json"), "utf8"),
    ])
    const manifest = JSON.parse(packageJson) as Record<string, Record<string, unknown> | undefined>
    const forbiddenEffectImport = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']effect(?:\/[^"']*)?["']/

    expect(declarations).toContain("class SandboxError extends ViteHubError")
    expect(declarations).toContain("type SandboxErrorJSON")
    expect(declarations).not.toMatch(forbiddenEffectImport)
    expect(javascript).not.toContain("better-result")
    expect(javascript).not.toContain("FiberFailure")
    expect(javascript).not.toMatch(forbiddenEffectImport)
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      expect(manifest[section] ?? {}).not.toHaveProperty("better-result")
      expect(manifest[section] ?? {}).not.toHaveProperty("effect")
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
