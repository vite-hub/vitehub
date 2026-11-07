import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { describeHostCredentials, resolveHostCredentials, runHostCli } from "../src/host-credentials.ts"
import { resolveCloudflareProvisionConfig, resolveVercelProvisionConfig } from "../src/provision.ts"

const fakeWrangler = fileURLToPath(new URL("./fixtures/wrangler/fake-wrangler.mjs", import.meta.url))
const isolatedFlags = ["--env-file", ".env", "--config", "wrangler.json"]

describe.skipIf(process.platform === "win32")("host credentials", () => {
  let dir: string
  let log: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vitehub-host-credentials-"))
    log = join(dir, "wrangler.log")
    writeFileSync(log, "")
  })

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true })
  })

  function installFakeWrangler() {
    const bin = join(dir, "wrangler")
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeWrangler}" "$@"\n`)
    chmodSync(bin, 0o755)
  }

  // HOME points at the empty tmp dir, so no real login can leak into a test.
  function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { FAKE_WRANGLER_LOG: log, HOME: dir, PATH: dir, ...extra }
  }

  function calls(): string[][] {
    return readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[])
  }

  it("prefers environment variables over the wrangler login", async () => {
    installFakeWrangler()
    const result = await resolveHostCredentials("cloudflare", { env: env({ CLOUDFLARE_ACCOUNT_ID: " env-account ", CLOUDFLARE_API_TOKEN: " env-token " }) })

    expect(result).toEqual({ ok: true, host: "cloudflare", source: "env", token: "env-token", accountId: "env-account" })
    expect(calls()).toEqual([])
  })

  it("uses the wrangler login when the token env var is missing", async () => {
    installFakeWrangler()
    const result = await resolveHostCredentials("cloudflare", { env: env() })

    expect(result).toEqual({ ok: true, host: "cloudflare", source: "host-cli", token: "fake-oauth-token-from-wrangler", accountId: "fake-account-id" })
    expect(calls()).toEqual([["auth", "token", "--json", ...isolatedFlags], ["whoami", "--json", ...isolatedFlags]])
  })

  it("keeps an env account id with a wrangler token", async () => {
    installFakeWrangler()
    const result = await resolveHostCredentials("cloudflare", { env: env({ CLOUDFLARE_ACCOUNT_ID: "env-account" }) })

    expect(result).toMatchObject({ ok: true, source: "host-cli", accountId: "env-account" })
    expect(calls()).toEqual([["auth", "token", "--json", ...isolatedFlags]])
  })

  it.each([".env", ".env.local"])("ignores project %s for both commands", async (envFile) => {
    installFakeWrangler()
    writeFileSync(join(dir, envFile), "CLOUDFLARE_API_TOKEN=project-token\n")
    const workingDirectories: string[] = []
    const suppliedEnv = env({ FAKE_WRANGLER_MODE: "project-state" })
    const result = await resolveHostCredentials("cloudflare", {
      cwd: dir,
      env: suppliedEnv,
      run: (command, args, options) => {
        workingDirectories.push(options.cwd!)
        expect(options.env).toEqual(suppliedEnv)
        return runHostCli(command, args, options)
      },
    })

    expect(result).toEqual({ ok: true, host: "cloudflare", source: "host-cli", token: "fake-oauth-token-from-wrangler", accountId: "fake-account-id" })
    expect(workingDirectories).toHaveLength(2)
    for (const cwd of workingDirectories) {
      expect(cwd).not.toBe(dir)
      expect(existsSync(cwd)).toBe(false)
    }
  })

  it("ignores project config when reading the CLI login", async () => {
    installFakeWrangler()
    writeFileSync(join(dir, "wrangler.json"), "invalid project config")
    const result = await resolveHostCredentials("cloudflare", { cwd: dir, env: env({ FAKE_WRANGLER_MODE: "project-state" }) })

    expect(result).toEqual({ ok: true, host: "cloudflare", source: "host-cli", token: "fake-oauth-token-from-wrangler", accountId: "fake-account-id" })
  })

  it("ignores project config when finding the account for a supplied token", async () => {
    installFakeWrangler()
    writeFileSync(join(dir, "wrangler.json"), "invalid project config")
    const result = await resolveHostCredentials("cloudflare", { cwd: dir, env: env({ CLOUDFLARE_API_TOKEN: "env-token", FAKE_WRANGLER_MODE: "project-state" }) })

    expect(result).toEqual({ ok: true, host: "cloudflare", source: "env", token: "env-token", accountId: "fake-account-id" })
  })

  it("preserves an ancestor's Wrangler profile while ignoring project env and config", async () => {
    installFakeWrangler()
    const project = join(dir, "project")
    const cwd = join(project, "nested")
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, ".env"), "CLOUDFLARE_API_TOKEN=project-token\n")
    writeFileSync(join(cwd, ".env.local"), "CLOUDFLARE_API_TOKEN=project-token\n")
    writeFileSync(join(cwd, "wrangler.json"), "invalid project config")

    const result = await resolveHostCredentials("cloudflare", {
      cwd,
      env: env({ FAKE_WRANGLER_MODE: "project-state", FAKE_WRANGLER_PROFILE_DIRECTORY: project }),
    })

    expect(result).toEqual({ ok: true, host: "cloudflare", source: "host-cli", token: "bound-profile-token", accountId: "bound-profile-account" })
    expect(calls()).toEqual([["auth", "token", "--json", ...isolatedFlags], ["whoami", "--json", ...isolatedFlags]])
  })

  it("does not treat a Global API Key as a bearer token", async () => {
    installFakeWrangler()
    const result = await resolveHostCredentials("cloudflare", { env: env({ FAKE_WRANGLER_MODE: "api-key" }) })

    expect(result).toMatchObject({ ok: false, missing: ["CLOUDFLARE_API_TOKEN"] })
  })

  it("returns the login fix when wrangler is not logged in", async () => {
    installFakeWrangler()
    const result = await resolveHostCredentials("cloudflare", { env: env({ FAKE_WRANGLER_MODE: "logged-out" }) })

    expect(result).toEqual({
      ok: false,
      host: "cloudflare",
      missing: ["CLOUDFLARE_API_TOKEN"],
      fix: "Run `wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
    })
  })

  it("returns the login fix when wrangler is not installed", async () => {
    const result = await resolveHostCredentials("cloudflare", { env: env() })

    expect(result).toMatchObject({ ok: false, host: "cloudflare", fix: expect.stringContaining("wrangler login") })
  })

  it("reads Vercel, Netlify, and Deno credentials from env vars only", async () => {
    installFakeWrangler()

    await expect(resolveHostCredentials("vercel", { env: env({ VERCEL_TOKEN: "v", VERCEL_ORG_ID: "org" }) })).resolves.toEqual({ ok: true, host: "vercel", source: "env", token: "v", teamId: "org" })
    await expect(resolveHostCredentials("vercel", { env: env({ VERCEL_TOKEN: "v", VERCEL_ORG_ID: "org", VERCEL_TEAM_ID: "team" }) })).resolves.toMatchObject({ teamId: "team" })
    await expect(resolveHostCredentials("netlify", { env: env({ NETLIFY_AUTH_TOKEN: "n" }) })).resolves.toEqual({ ok: true, host: "netlify", source: "env", token: "n" })
    await expect(resolveHostCredentials("deno", { env: env({ DENO_DEPLOY_TOKEN: "d" }) })).resolves.toEqual({ ok: true, host: "deno", source: "env", token: "d" })
    await expect(resolveHostCredentials("vercel", { env: env() })).resolves.toMatchObject({ ok: false, missing: ["VERCEL_TOKEN"] })
    await expect(resolveHostCredentials("netlify", { env: env() })).resolves.toMatchObject({ ok: false, missing: ["NETLIFY_AUTH_TOKEN"] })
    await expect(resolveHostCredentials("deno", { env: env() })).resolves.toMatchObject({ ok: false, missing: ["DENO_DEPLOY_TOKEN"] })
    expect(calls()).toEqual([])
  })

  it("never returns or prints a token in descriptions", async () => {
    installFakeWrangler()
    const fromCli = await describeHostCredentials("cloudflare", { env: env() })
    const fromEnv = await describeHostCredentials("vercel", { env: env({ VERCEL_TOKEN: "secret-vercel-token" }) })
    const missing = await describeHostCredentials("netlify", { env: env() })
    const output = JSON.stringify([fromCli, fromEnv, missing])

    expect(fromCli).toEqual({ ok: true, host: "cloudflare", source: "host-cli", accountId: "fake-account-id" })
    expect(output).not.toContain("fake-oauth-token-from-wrangler")
    expect(output).not.toContain("secret-vercel-token")
    expect(output).not.toContain("token\":")
  })

  it("keeps the provision env contract", () => {
    expect(resolveCloudflareProvisionConfig({ CLOUDFLARE_API_TOKEN: "t" })).toBeUndefined()
    expect(resolveCloudflareProvisionConfig({ CLOUDFLARE_ACCOUNT_ID: "a" })).toBeUndefined()
    expect(resolveCloudflareProvisionConfig({ CLOUDFLARE_ACCOUNT_ID: " a ", CLOUDFLARE_API_TOKEN: " t " })).toEqual({ accountId: "a", token: "t" })
    expect(resolveVercelProvisionConfig({ VERCEL_TOKEN: " " })).toBeUndefined()
    expect(resolveVercelProvisionConfig({ VERCEL_TOKEN: "t", VERCEL_ORG_ID: "org" })).toEqual({ token: "t", teamId: "org" })
  })
})
