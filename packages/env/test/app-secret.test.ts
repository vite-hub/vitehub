import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { deriveViteHubSecret } from "@vite-hub/internal/secret"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveConfig } from "vite"

import { consoleBodySha256, readConsolePublicKeys, readConsoleSigningKey, signConsoleRequest, verifyConsoleSignature } from "@vite-hub/internal/console-signature"

import { secretCliFeatures } from "../src/secret-cli.ts"
import { unseal } from "../src/index.ts"
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
    // Nuxt's app secret is not a ViteHub root secret.
    vi.stubEnv("NUXT_APP_SECRET", "nuxt-root-secret-at-least-32-characters")
    vi.stubEnv("VITEHUB_SECRET_GENERATED", "")
    const root = await runConfig("serve")
    const secretPath = join(root, ".vitehub", "env", "secret")
    const secret = (await readFile(secretPath, "utf8")).trim()

    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600)
    expect(process.env.VITEHUB_SECRET).toBe("")
    expect(process.env.VITEHUB_SECRET_GENERATED).toBe("")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(deriveSecret("app:session", { root: secret }, { generated: true })).resolves.toBe(await deriveViteHubSecret(secret, "app:session"))
    const config = await resolveConfig({ configFile: false, root, plugins: [hubEnv()] }, "serve")
    expect(config).toHaveProperty("__vitehubEnvDevelopmentSecret", secret)
    expect(await readFile(secretPath, "utf8")).toBe(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("generated development VITEHUB_SECRET"))
    warn.mockRestore()
  })

  it("seals with the generated development secret through #vitehub/env/server", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    vi.stubEnv("NUXT_APP_SECRET", "")
    vi.stubEnv("VITEHUB_SECRET_GENERATED", "")
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-seal-dev-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "seal-dev-app", type: "module" }))
    await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
    await symlink(new URL("..", import.meta.url).pathname, join(root, "node_modules", "@vite-hub", "env"), "dir")
    await resolveConfig({ configFile: false, root, plugins: [hubEnv()] }, "serve")
    const secret = (await readFile(join(root, ".vitehub", "env", "secret"), "utf8")).trim()
    const generated = await import(pathToFileURL(join(root, ".vitehub", "env", "server.mjs")).href)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sealed: string = await generated.seal("app:upload", { userId: "u_1" }, { ttl: 60 })
    expect(await generated.unseal("app:upload", sealed)).toEqual([undefined, { userId: "u_1" }])
    expect(await unseal("app:upload", sealed, { secret })).toEqual([undefined, { userId: "u_1" }])
    warn.mockRestore()
    await expect(readFile(join(root, ".vitehub", "env", "server.d.ts"), "utf8")).resolves.toContain("export const seal: typeof import(\"@vite-hub/env/internal/server\").seal")
  })

  it("isolates generated, configured, and later generated projects", async () => {
    vi.stubEnv("VITEHUB_SECRET", undefined)
    vi.stubEnv("VITEHUB_SECRET_GENERATED", "")
    const projectRoots = await Promise.all(["first", "configured", "last"].map(name => mkdtemp(join(tmpdir(), `vitehub-${name}-`))))
    roots.push(...projectRoots)
    const [first, configured, last] = projectRoots
    const configuredSecret = "configured-project-root-at-least-32-characters"
    await writeFile(join(configured!, ".env.development"), `VITEHUB_SECRET=${configuredSecret}\n`)
    const configs = []
    for (const root of projectRoots) {
      configs.push(await resolveConfig({ configFile: false, root, plugins: [hubEnv()] }, "serve"))
    }
    const firstSecret = await readFile(join(first!, ".vitehub/env/secret"), "utf8")
    const lastSecret = await readFile(join(last!, ".vitehub/env/secret"), "utf8")
    expect(firstSecret).not.toBe(lastSecret)
    for (const [index, secret] of [firstSecret, configuredSecret, lastSecret].entries()) {
      expect(configs[index]).toHaveProperty("__vitehubEnvDevelopmentSecret", secret)
      expect(await readFile(join(projectRoots[index]!, ".vitehub/env/server.mjs"), "utf8")).not.toContain(JSON.stringify(secret))
    }
    await expect(stat(join(configured!, ".vitehub/env/secret"))).rejects.toThrow()
  })

  it("honors a project VITEHUB_SECRET and preserves shell precedence", async () => {
    const name = "VITEHUB_SECRET"
    vi.stubEnv(name, undefined)
    const root = await mkdtemp(join(tmpdir(), "vitehub-configured-secret-"))
    roots.push(root)
    const projectSecret = "project-root-secret-at-least-32-characters"
    await writeFile(join(root, ".env.development"), `${name}=${projectSecret}\n`)
    const config = await resolveConfig({ configFile: false, root, plugins: [hubEnv()] }, "serve")
    expect(config).toHaveProperty("__vitehubEnvDevelopmentSecret", projectSecret)
    expect(process.env[name]).toBeUndefined()
    const shellSecret = "shell-root-secret-at-least-32-characters"
    vi.stubEnv(name, shellSecret)
    const shellConfig = await resolveConfig({ configFile: false, root, plugins: [hubEnv()] }, "serve")
    expect(shellConfig).toHaveProperty("__vitehubEnvDevelopmentSecret", shellSecret)
    await expect(stat(join(root, ".vitehub/env/secret"))).rejects.toThrow()
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
    vi.stubEnv("NUXT_APP_SECRET", "nuxt-root-secret-at-least-32-characters")
    await expect(deriveSecret("app:session")).rejects.toMatchObject({ code: "ENV_REQUIRED_MISSING" })
  })

  it("generates a root secret and derives purpose secrets from the CLI", async () => {
    const [generate, derive] = secretCliFeatures
    const generated = output()
    expect(await generate!.run([], { env: {}, stderr: output().stream, stdout: generated.stream } as never)).toBe(0)
    expect(Buffer.from(generated.text().trim(), "base64")).toHaveLength(32)

    const derived = output()
    const env = { VITEHUB_SECRET: "cli-root-secret-at-least-32-characters-long" }
    expect(await derive!.run(["app:webhooks"], { env, stderr: output().stream, stdout: derived.stream } as never)).toBe(0)
    expect(derived.text().trim()).toBe(await deriveViteHubSecret(env.VITEHUB_SECRET, "app:webhooks"))

    const missing = output()
    expect(await derive!.run(["app:webhooks"], { env: {}, stderr: missing.stream, stdout: output().stream } as never)).toBe(1)
    expect(missing.text()).toContain("Set VITEHUB_SECRET")
  })

  it("prints a Console key pair whose private key signs requests that the public key verifies", async () => {
    const consoleKey = secretCliFeatures.find(feature => feature.name === "console-key")!
    const printed = output()
    expect(await consoleKey.run(["ci"], { env: {}, stderr: output().stream, stdout: printed.stream } as never)).toBe(0)
    const lines = Object.fromEntries(printed.text().split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split("=") as [string, string]))
    expect(Object.keys(lines)).toEqual(["VITEHUB_CONSOLE_KEY_CI", "VITEHUB_CONSOLE_PRIVATE_KEY_CI"])
    const key = readConsoleSigningKey({ VITEHUB_CONSOLE_PRIVATE_KEY_CI: lines.VITEHUB_CONSOLE_PRIVATE_KEY_CI })!
    const url = "https://app.example.com/_vitehub/rpc"
    const body = JSON.stringify({ a: [{}], i: "1", m: "project.get", t: "q" })
    const headers = new Headers(await signConsoleRequest({ body, caller: { via: "cli" }, key, method: "POST", url }))
    const keys = readConsolePublicKeys({ VITEHUB_CONSOLE_KEY_CI: lines.VITEHUB_CONSOLE_KEY_CI })
    if (!(keys instanceof Map)) throw new Error(keys.message)
    await expect(verifyConsoleSignature({ headers, keys, method: "POST", origin: "https://app.example.com", url })).resolves.toEqual({
      bodySha256: await consoleBodySha256(body),
      caller: { via: "cli" },
      key: "CI",
      ok: true,
    })

    const refused = output()
    expect(await consoleKey.run(["a", "b"], { env: {}, stderr: refused.stream, stdout: output().stream } as never)).toBe(1)
    expect(refused.text()).toContain("Usage: vitehub secret console-key [name]")
  })
})
