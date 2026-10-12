import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { deriveViteHubSecret } from "@vite-hub/internal/secret"
import { afterEach, describe, expect, it, vi } from "vitest"

import { secretCliFeatures } from "../src/secret-cli.ts"
import { deriveSecret } from "../src/server.ts"
import { hubEnv } from "../src/vite.ts"

const roots: string[] = []

async function runConfig(command: "build" | "serve"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-env-secret-"))
  roots.push(root)
  const configHook = hubEnv().config as (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>
  await configHook({ root }, { command, mode: command === "serve" ? "development" : "production" })
  return root
}

function output() {
  let text = ""
  return { stream: { write: (chunk: unknown) => { text += String(chunk) } }, text: () => text }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("root app secret", () => {
  it("generates and keeps a development secret when none is configured", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    vi.stubEnv("NUXT_APP_SECRET", "")
    vi.stubEnv("VITEHUB_SECRET_GENERATED", "")
    const root = await runConfig("serve")
    const secretPath = join(root, ".vitehub", "env", "secret")
    const secret = (await readFile(secretPath, "utf8")).trim()

    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600)
    expect(process.env.VITEHUB_SECRET).toBe(secret)
    expect(process.env.VITEHUB_SECRET_GENERATED).toBe("1")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(deriveSecret("app:session")).resolves.toBe(await deriveViteHubSecret(secret, "app:session"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("generated development VITEHUB_SECRET"))
    warn.mockRestore()
  })

  it("keeps a configured secret and never generates one for a build", async () => {
    vi.stubEnv("VITEHUB_SECRET", "configured-root-secret-at-least-32-characters")
    vi.stubEnv("VITEHUB_SECRET_GENERATED", "")
    const served = await runConfig("serve")
    expect(process.env.VITEHUB_SECRET).toBe("configured-root-secret-at-least-32-characters")
    await expect(stat(join(served, ".vitehub", "env", "secret"))).rejects.toThrow()

    vi.stubEnv("VITEHUB_SECRET", "")
    const built = await runConfig("build")
    await expect(stat(join(built, ".vitehub", "env", "secret"))).rejects.toThrow()
    expect(process.env.VITEHUB_SECRET).toBe("")
  })

  it("derives from VITEHUB_SECRET and reports a missing or short root by Env error code", async () => {
    vi.stubEnv("VITEHUB_SECRET", "runtime-root-secret-at-least-32-characters")
    await expect(deriveSecret("app:session")).resolves.toBe(await deriveViteHubSecret("runtime-root-secret-at-least-32-characters", "app:session"))
    vi.stubEnv("VITEHUB_SECRET", "short")
    await expect(deriveSecret("app:session")).rejects.toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID" })
    vi.stubEnv("VITEHUB_SECRET", "")
    vi.stubEnv("NUXT_APP_SECRET", "")
    await expect(deriveSecret("app:session")).rejects.toMatchObject({ code: "ENV_REQUIRED_MISSING" })
  })

  it("generates a root secret and derives purpose secrets from the CLI", async () => {
    const [generate, derive] = secretCliFeatures
    const generated = output()
    expect(await generate!.run([], { env: {}, stderr: output().stream, stdout: generated.stream } as never)).toBe(0)
    expect(Buffer.from(generated.text().trim(), "base64")).toHaveLength(32)

    const derived = output()
    const env = { VITEHUB_SECRET: "cli-root-secret-at-least-32-characters-long" }
    expect(await derive!.run(["vitehub:dispatch"], { env, stderr: output().stream, stdout: derived.stream } as never)).toBe(0)
    expect(derived.text().trim()).toBe(await deriveViteHubSecret(env.VITEHUB_SECRET, "vitehub:dispatch"))

    const missing = output()
    expect(await derive!.run(["vitehub:dispatch"], { env: {}, stderr: missing.stream, stdout: output().stream } as never)).toBe(1)
    expect(missing.text()).toContain("Set VITEHUB_SECRET")
  })
})
