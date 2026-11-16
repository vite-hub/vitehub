import { execFileSync } from "node:child_process"
import { readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { expectNoLeak, fakeHosts } from "./setup-deploy-helpers.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { SetupError } from "../src/setup/index.ts"
import type { EnvDiffOutput, EnvPushOutput } from "../src/setup/env.ts"
import type { FakeHosts } from "./setup-deploy-helpers.ts"

type Host = "cloudflare" | "vercel" | "netlify" | "deno"
type DiffJson = EnvDiffOutput & { error?: SetupError, rerun?: string }
type PushJson = EnvPushOutput & { error?: SetupError, rerun?: string }

/** A value that must never leave the CLI except on the stdin of a host CLI or in a host API body. */
const canary = "canary-7f3a9c1e5b2d"

/** Names as `deployment.json` lists them: a primitive name, a Server Env secret with an alias, an optional value, and a prefix. */
const envEntries = [
  { names: ["VITEHUB_SECRET"], required: true, secret: true, hasDefault: false, owners: ["vite-hub"] },
  { path: "env.server.github.token", names: ["VITEHUB_GITHUB_TOKEN", "GITHUB_TOKEN"], required: true, secret: true, hasDefault: false },
  { path: "env.server.sentryDsn", names: ["SENTRY_DSN"], required: false, secret: false, hasDefault: false },
  { names: [], prefix: "VITEHUB_CONSOLE_KEY_", required: false, secret: false, hasDefault: false, owners: ["console"] },
]

const outputDirs: Record<Host, string> = { cloudflare: ".output", deno: ".output", netlify: ".netlify", vercel: ".vercel/output" }

const links = {
  cloudflare: { account: { id: "acc-1" }, project: { name: "my-app" }, verified: true, linkedAt: "2026-11-15T00:00:00.000Z" },
  deno: { account: { id: "acme" }, project: { name: "my-app" }, verified: true, linkedAt: "2026-11-15T00:00:00.000Z" },
  netlify: { account: { id: "acct-1" }, project: { id: "site-1", name: "my-app" }, verified: true, linkedAt: "2026-11-15T00:00:00.000Z" },
  vercel: { account: { id: "team_1" }, project: { id: "prj_1", name: "my-app" }, verified: true, linkedAt: "2026-11-15T00:00:00.000Z" },
}

function manifest(host: Host, env: readonly object[] = envEntries): Record<string, string> {
  return { [`${outputDirs[host]}/deployment.json`]: JSON.stringify({ env, host, identity: { name: "my-app", source: "package" } }) }
}

/** A built, linked project. `hosts` are the link targets, the first is the default. */
async function linkedProject(hosts: readonly Host[], files: Record<string, string> = {}): Promise<string> {
  return await createProject({
    "package.json": JSON.stringify({ name: "my-app", packageManager: "pnpm@10.0.0", scripts: { build: "vite build" }, type: "module" }),
    ".gitignore": ".output\n.vercel\n.netlify\n.vitehub\n.env*\n",
    ".vitehub/link.json": JSON.stringify({ default: hosts[0], schemaVersion: 2, targets: Object.fromEntries(hosts.map(host => [host, links[host]])) }),
    ...Object.assign({}, ...hosts.map(host => manifest(host))),
    ...files,
  })
}

/** Seeds the fake hosts with variables, as if an earlier push or the dashboard set them. */
async function seed(hosts: FakeHosts, state: object): Promise<void> {
  await writeFile(hosts.env.FAKE_HOST_STATE!, JSON.stringify({ deploys: 0, secrets: {}, ...state }))
}

/** The Netlify environment variables API, writing into the fake CLI state so `netlify env:list` sees the values. */
function netlifyApi(hosts: FakeHosts): { fetch: typeof fetch, requests: { method: string, url: string, body?: unknown }[] } {
  const requests: { method: string, url: string, body?: unknown }[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ method, url, ...(body === undefined ? {} : { body }) })
    const state = JSON.parse(await readFile(hosts.env.FAKE_HOST_STATE!, "utf8").catch(() => "{}")) as { netlify?: Record<string, Record<string, string>> }
    state.netlify ??= {}
    const path = new URL(url).pathname
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status })
    const key = /\/env\/(\w+)$/u.exec(path)?.[1]
    if (method === "GET" && key) {
      const found = Object.values(state.netlify).some(values => key in values)
      return found ? json({ key, scopes: ["functions"], is_secret: true }) : json({ message: "Not Found" }, 404)
    }
    const write = (name: string, context: string, value: string) => {
      state.netlify![context] = { ...state.netlify![context], [name]: value }
    }
    if (method === "PATCH" && key && body && typeof body === "object") {
      const { context, value } = body as { context: string, value: string }
      write(key, context, value)
    }
    else if (method === "POST" && Array.isArray(body)) {
      for (const item of body as { key: string, values: { context: string, value: string }[] }[]) {
        for (const value of item.values) write(item.key, value.context, value.value)
      }
    }
    else throw new Error(`unexpected request ${method} ${url}`)
    await writeFile(hosts.env.FAKE_HOST_STATE!, JSON.stringify(state))
    return json({})
  }
  return { fetch: fakeFetch, requests }
}

function envCommand<T>(args: string[], root: string, env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch, spawn?: ViteHubCliSpawn } = {}) {
  return runSetup<T>(["env", ...args, "--json"], root, env, options)
}

const hostEnv: Record<Host, NodeJS.ProcessEnv> = {
  cloudflare: { CLOUDFLARE_API_TOKEN: "cf-token-1" },
  deno: { DENO_DEPLOY_TOKEN: "deno-token-1" },
  netlify: { NETLIFY_AUTH_TOKEN: "netlify-token-1" },
  vercel: { VERCEL_TOKEN: "vercel-token-1" },
}
const tokens = ["cf-token-1", "deno-token-1", "netlify-token-1", "vercel-token-1"]

/** Host state with VITEHUB_SECRET and an unknown name set for the production target. */
const seeded: Record<Host, object> = {
  cloudflare: { secrets: { OLD_TOKEN: "x", VITEHUB_SECRET: "x" } },
  deno: { denoApp: true, secrets: { OLD_TOKEN: "x", VITEHUB_SECRET: "x" } },
  netlify: { netlify: { production: { OLD_TOKEN: "x", VITEHUB_SECRET: "x" } } },
  vercel: { vercel: { production: { OLD_TOKEN: "x", VITEHUB_SECRET: "x" } } },
}

describe("vitehub env diff", () => {
  it.each(["cloudflare", "vercel", "netlify", "deno"] as const)("reports missing required, missing optional, and extra names on %s", async (host) => {
    const root = await linkedProject([host])
    const hosts = await fakeHosts(hostEnv[host])
    await seed(hosts, seeded[host])
    const result = await envCommand<DiffJson>(["diff"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(1)
    expect(result.json).toEqual({
      extra: ["OLD_TOKEN"],
      host,
      missing: {
        optional: [
          { names: ["SENTRY_DSN"], path: "env.server.sentryDsn", secret: false },
          { names: [], owners: ["console"], prefix: "VITEHUB_CONSOLE_KEY_", secret: false },
        ],
        required: [{ names: ["VITEHUB_GITHUB_TOKEN", "GITHUB_TOKEN"], path: "env.server.github.token", secret: true }],
      },
      ok: false,
      project: "my-app",
      schemaVersion: 1,
      stage: "production",
      target: "production",
    })
    // Only a read: one listing, no write.
    expect((await hosts.calls()).map(call => call.argv.slice(0, 3).join(" "))).toEqual([{
      cloudflare: "secret list --format",
      deno: "deploy env list",
      netlify: "env:list --context production",
      vercel: "env ls --environment",
    }[host]])
  })

  it("passes when the host has an alias, a prefix name, and every required name, and prints names only", async () => {
    const root = await linkedProject(["cloudflare"])
    const hosts = await fakeHosts(hostEnv.cloudflare)
    await seed(hosts, { secrets: { GITHUB_TOKEN: "x", SENTRY_DSN: "x", VITEHUB_CONSOLE_KEY_CI: "x", VITEHUB_SECRET: "x" } })
    const result = await runSetup(["env", "diff"], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe("Env names of my-app on cloudflare, stage production:\nEvery name is on the host.\nHosts do not return values, so this compares names only.\n")
  })

  it("reads the Cloudflare target with the linked Worker name and account", async () => {
    const root = await linkedProject(["cloudflare"])
    const hosts = await fakeHosts(hostEnv.cloudflare)
    await envCommand(["diff"], root, hosts.env)
    const [call] = await hosts.calls()
    expect(call).toMatchObject({ accountId: "acc-1", argv: ["secret", "list", "--format", "json", "--name", "my-app"], cwd: root })
  })

  it("builds for the host when the build output is missing, then reads its names", async () => {
    const root = await linkedProject(["cloudflare"])
    await writeFile(join(root, ".output/deployment.json"), JSON.stringify({ env: envEntries, host: "vercel" }))
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const builds: NodeJS.ProcessEnv[] = []
    const spawn: ViteHubCliSpawn = async (command, args, options) => {
      expect([command, ...args]).toEqual(["pnpm", "run", "build"])
      builds.push(options?.env ?? {})
      await writeFile(join(root, ".output/deployment.json"), JSON.stringify({ env: [envEntries[0]], host: "cloudflare" }))
      return { exitCode: 0 }
    }
    const result = await envCommand<DiffJson>(["diff"], root, hosts.env, { spawn })

    expect(builds).toHaveLength(1)
    expect(builds[0]).toMatchObject({ VITEHUB_HOST: "cloudflare", VITEHUB_HOST_SOURCE: "cli" })
    expect(result.json.missing.required).toEqual([{ names: ["VITEHUB_SECRET"], owners: ["vite-hub"], secret: true }])
  })

  it("--host picks the target of link.json v2, and several targets without a default need --host", async () => {
    const root = await linkedProject(["cloudflare", "vercel"])
    const hosts = await fakeHosts({ ...hostEnv.cloudflare, ...hostEnv.vercel })
    await seed(hosts, { vercel: { production: { VITEHUB_SECRET: "x" } } })
    const result = await envCommand<DiffJson>(["diff", "--host", "vercel"], root, hosts.env)

    expect(result.json).toMatchObject({ host: "vercel", project: "my-app" })
    const calls = await hosts.calls()
    expect(calls.map(call => [call.name, call.argv])).toEqual([["vercel", ["env", "ls", "--environment", "production", "--json", "--project", "prj_1", "--scope", "team_1"]]])

    const link = JSON.parse(await readFile(join(root, ".vitehub/link.json"), "utf8")) as Record<string, unknown>
    await writeFile(join(root, ".vitehub/link.json"), JSON.stringify({ ...link, default: undefined }))
    const ambiguous = await envCommand<DiffJson>(["diff"], root, hosts.env)
    expect(ambiguous.exitCode).toBe(2)
    expect(ambiguous.json).toMatchObject({ error: { code: "SETUP_LINK_HOST_REQUIRED" }, rerun: "vitehub env diff --host cloudflare" })
  })

  it("fails with a link fix when the host has no target", async () => {
    const root = await linkedProject(["cloudflare"])
    const hosts = await fakeHosts(hostEnv.vercel)
    const result = await envCommand<DiffJson>(["diff", "--host", "vercel"], root, hosts.env)
    expect(result.exitCode).toBe(2)
    expect(result.json).toMatchObject({ error: { code: "SETUP_DEPLOYMENTS_NOT_LINKED" }, rerun: "vitehub link --host vercel" })
    expect(await hosts.calls()).toEqual([])
  })

  it("maps --stage preview to the Vercel preview environment and refuses it on Cloudflare", async () => {
    const root = await linkedProject(["vercel", "cloudflare"])
    const hosts = await fakeHosts({ ...hostEnv.vercel, ...hostEnv.cloudflare })
    await seed(hosts, { vercel: { preview: { GITHUB_TOKEN: "x", VITEHUB_SECRET: "x" }, production: {} } })
    const preview = await envCommand<DiffJson>(["diff", "--stage", "preview"], root, hosts.env)
    expect(preview.exitCode, preview.stdout).toBe(0)
    expect(preview.json).toMatchObject({ ok: true, stage: "preview", target: "preview" })

    const cloudflare = await envCommand<DiffJson>(["diff", "--host", "cloudflare", "--stage", "preview"], root, hosts.env)
    expect(cloudflare.exitCode).toBe(3)
    expect(cloudflare.json.error).toMatchObject({ code: "SETUP_ENV_STAGE_UNSUPPORTED" })
    const staging = await envCommand<DiffJson>(["diff", "--stage", "staging"], root, hosts.env)
    expect(staging.json.error).toMatchObject({ code: "SETUP_ENV_STAGE_UNSUPPORTED" })
  })
})

describe("vitehub env push", () => {
  const local = {
    ".env": "SENTRY_DSN=https://sentry.example/1\n",
    ".env.production": `VITEHUB_SECRET=${canary}\nGITHUB_TOKEN=gh-from-file\nVITEHUB_CONSOLE_KEY_CI=console-key-ci\n`,
    ".env.preview": "VITEHUB_SECRET=preview-secret\n",
  }

  it.each(["cloudflare", "vercel", "deno"] as const)("sends values on stdin only on %s, and never prints them", async (host) => {
    const root = await linkedProject([host], local)
    const hosts = await fakeHosts({ ...hostEnv[host], VITEHUB_GITHUB_TOKEN: "gh-from-shell" })
    await seed(hosts, seeded[host])
    const result = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.json.pushed).toEqual([
      { name: "VITEHUB_SECRET", replaced: true, secret: true, source: ".env.production" },
      { name: "VITEHUB_GITHUB_TOKEN", replaced: false, secret: true, source: "process" },
      { name: "SENTRY_DSN", replaced: false, secret: false, source: ".env" },
      { name: "VITEHUB_CONSOLE_KEY_CI", replaced: false, secret: false, source: ".env.production" },
    ])
    expect(result.json.skipped).toEqual([])
    const calls = await hosts.calls()
    const writes = calls.filter(call => call.stdin)
    expect(writes).toHaveLength(4)
    if (host === "deno") expect(writes.map(call => call.stdin)).toEqual([`VITEHUB_SECRET='${canary}'\n`, "VITEHUB_GITHUB_TOKEN='gh-from-shell'\n", "SENTRY_DSN='https://sentry.example/1'\n", "VITEHUB_CONSOLE_KEY_CI='console-key-ci'\n"])
    else expect(writes.map(call => call.stdin)).toEqual([canary, "gh-from-shell", "https://sentry.example/1", "console-key-ci"])
    expectNoLeak(calls, result.stdout + result.stderr, [canary, "gh-from-shell", "console-key-ci", ...tokens])
    expect(JSON.stringify(result.json)).not.toContain(canary)
  })

  it("passes the secret flag the way each host CLI takes it", async () => {
    const vercelRoot = await linkedProject(["vercel"], local)
    const vercel = await fakeHosts(hostEnv.vercel)
    await envCommand(["push", "--yes", "--only", "VITEHUB_SECRET", "--only", "SENTRY_DSN"], vercelRoot, vercel.env)
    expect((await vercel.calls()).filter(call => call.argv[1] === "add").map(call => call.argv)).toEqual([
      ["env", "add", "VITEHUB_SECRET", "--environment", "production", "--sensitive", "--force", "--yes", "--project", "prj_1", "--scope", "team_1"],
      ["env", "add", "SENTRY_DSN", "--environment", "production", "--no-sensitive", "--force", "--yes", "--project", "prj_1", "--scope", "team_1"],
    ])

    const denoRoot = await linkedProject(["deno"], local)
    const deno = await fakeHosts(hostEnv.deno)
    await seed(deno, seeded.deno)
    await envCommand(["push", "--yes", "--only", "VITEHUB_SECRET", "--only", "SENTRY_DSN"], denoRoot, deno.env)
    expect((await deno.calls()).filter(call => call.argv[2] === "load").map(call => call.argv)).toEqual([
      ["deploy", "env", "load", "/dev/stdin", "--replace", "--json", "--non-interactive", "--org", "acme", "--app", "my-app"],
      ["deploy", "env", "load", "/dev/stdin", "--replace", "--non-secrets", "SENTRY_DSN", "--json", "--non-interactive", "--org", "acme", "--app", "my-app"],
    ])
  })

  it.each([false, true])("refuses a Deno secret without a secret-classified name (existing: %s)", async (existing) => {
    const root = await linkedProject(["deno"], {
      ...manifest("deno", [{ names: ["DATABASE_URL"], required: true, secret: true, hasDefault: false }]),
    })
    const hosts = await fakeHosts({ ...hostEnv.deno, DATABASE_URL: canary })
    await seed(hosts, { denoApp: true, secrets: existing ? { DATABASE_URL: "previous-secret" } : {} })
    const result = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)
    expect(result.exitCode).not.toBe(0)
    expect(result.json.error?.code).toBe("SETUP_ENV_VALUE_UNSUPPORTED")
    expect((await hosts.calls()).some(call => call.argv[2] === "load")).toBe(false)
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [canary])
  })

  it("lists only Netlify Functions variables and refuses a Builds-only update before writing", async () => {
    const root = await linkedProject(["netlify"], local)
    const hosts = await fakeHosts(hostEnv.netlify)
    await seed(hosts, { netlify: { production: { VITEHUB_SECRET: "build-only" } }, netlifyScopes: { VITEHUB_SECRET: ["builds"] } })
    const diff = await envCommand<DiffJson>(["diff"], root, hosts.env)
    expect(diff.exitCode).toBe(1)
    expect((await hosts.calls()).find(call => call.argv[0] === "env:list")?.argv).toContain("functions")
    const requests: string[] = []
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requests.push(init?.method ?? "GET")
      return Response.json({ key: "VITEHUB_SECRET", scopes: ["builds"], is_secret: true })
    }
    const push = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, hosts.env, { fetch })
    expect(push.exitCode).not.toBe(0)
    expect(push.json.error?.code).toBe("SETUP_ENV_VALUE_UNSUPPORTED")
    expect(requests).toEqual(["GET"])
    expectNoLeak(await hosts.calls(), push.stdout + push.stderr, [canary])
  })

  it("sends Netlify values in an API body for the production context, never in argv", async () => {
    const root = await linkedProject(["netlify"], local)
    const hosts = await fakeHosts(hostEnv.netlify)
    await seed(hosts, seeded.netlify)
    const api = netlifyApi(hosts)
    const result = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET", "--only", "GITHUB_TOKEN"], root, hosts.env, { fetch: api.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(api.requests.map(request => [request.method, request.url, request.body])).toEqual([
      ["GET", "https://api.netlify.com/api/v1/accounts/acct-1/env/VITEHUB_SECRET?site_id=site-1", undefined],
      ["PATCH", "https://api.netlify.com/api/v1/accounts/acct-1/env/VITEHUB_SECRET?site_id=site-1", { context: "production", value: canary }],
      ["GET", "https://api.netlify.com/api/v1/accounts/acct-1/env/GITHUB_TOKEN?site_id=site-1", undefined],
      ["POST", "https://api.netlify.com/api/v1/accounts/acct-1/env?site_id=site-1", [{ is_secret: true, key: "GITHUB_TOKEN", scopes: ["functions"], values: [{ context: "production", value: "gh-from-file" }] }]],
    ])
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [canary, "gh-from-file", ...tokens])
  })

  it("refuses a secret from a file that git tracks, before it calls the host", async () => {
    const root = await linkedProject(["cloudflare"], local)
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, LC_ALL: "C" } })
    git("init", "-q")
    git("add", "-f", ".env.production")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)

    expect(result.exitCode).toBe(3)
    expect(result.json.error).toMatchObject({ code: "SETUP_ENV_FILE_TRACKED", fix: expect.stringContaining("git rm --cached .env.production") })
    expect(result.json.error?.why).toContain("VITEHUB_SECRET, GITHUB_TOKEN")
    expect(await hosts.calls()).toEqual([])
    expect(result.stdout + result.stderr).not.toContain(canary)

    // A plain value from a tracked file and a secret from the shell go through.
    git("add", "-f", ".env")
    const plain = await envCommand<PushJson>(["push", "--yes", "--only", "SENTRY_DSN"], root, hosts.env)
    expect(plain.json.pushed).toEqual([{ name: "SENTRY_DSN", replaced: false, secret: false, source: ".env" }])
    const shell = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, { ...hosts.env, VITEHUB_SECRET: canary })
    expect(shell.json.pushed).toEqual([{ name: "VITEHUB_SECRET", replaced: false, secret: true, source: "process" }])
  })

  it("redacts the values from host CLI error output", async () => {
    const root = await linkedProject(["cloudflare"], local)
    const hosts = await fakeHosts({ ...hostEnv.cloudflare, FAKE_HOST_ECHO_STDIN: "1", FAKE_HOST_FAIL: "wrangler secret put" })
    const result = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)

    expect(result.exitCode).toBe(1)
    expect(result.json.error).toMatchObject({ code: "SETUP_DEPLOY_FAILED" })
    expect(result.json.error?.why).toContain("could not read value: <redacted>")
    expect(result.stdout + result.stderr).not.toContain(canary)
  })

  it("needs --yes without a terminal and pushes nothing", async () => {
    const root = await linkedProject(["cloudflare"], local)
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--only", "VITEHUB_SECRET"], root, hosts.env)
    expect(result.exitCode).toBe(2)
    expect(result.json).toMatchObject({ error: { code: "CLI_R0004" }, rerun: "vitehub env push --only VITEHUB_SECRET --yes --json" })
    expect(await hosts.calls()).toEqual([])
  })

  it("lists entries without a local value, rejects unknown --only names, and never deletes", async () => {
    const root = await linkedProject(["cloudflare"], { ".env.production": "SENTRY_DSN=https://sentry.example/2\n" })
    const hosts = await fakeHosts(hostEnv.cloudflare)
    await seed(hosts, seeded.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)
    expect(result.json.pushed.map(item => item.name)).toEqual(["SENTRY_DSN"])
    expect(result.json.skipped).toEqual([
      { names: ["VITEHUB_SECRET"], owners: ["vite-hub"], required: true, secret: true },
      { names: ["VITEHUB_GITHUB_TOKEN", "GITHUB_TOKEN"], path: "env.server.github.token", required: true, secret: true },
      { names: [], owners: ["console"], prefix: "VITEHUB_CONSOLE_KEY_", required: false, secret: false },
    ])
    expect((await hosts.state()).secrets).toEqual({ OLD_TOKEN: "x", SENTRY_DSN: "https://sentry.example/2", VITEHUB_SECRET: "x" })

    const unknown = await envCommand<PushJson>(["push", "--yes", "--only", "NOT_DECLARED"], root, hosts.env)
    expect(unknown.exitCode).toBe(2)
    expect(unknown.json.error).toMatchObject({ code: "SETUP_ENV_NAME_UNKNOWN" })
  })

  it.each(["cloudflare", "vercel", "netlify", "deno"] as const)("diff, push, diff is clean on %s", async (host) => {
    const root = await linkedProject([host], local)
    const hosts = await fakeHosts({ ...hostEnv[host], VITEHUB_GITHUB_TOKEN: "gh-from-shell" })
    if (host === "deno") await seed(hosts, { denoApp: true })
    const api = netlifyApi(hosts)
    const before = await envCommand<DiffJson>(["diff"], root, hosts.env, { fetch: api.fetch })
    expect(before.json.missing.required.length).toBe(2)
    const pushed = await envCommand<PushJson>(["push", "--yes"], root, hosts.env, { fetch: api.fetch })
    expect(pushed.exitCode, pushed.stdout + pushed.stderr).toBe(0)
    const after = await envCommand<DiffJson>(["diff"], root, hosts.env, { fetch: api.fetch })
    expect(after.exitCode, after.stdout).toBe(0)
    expect(after.json).toMatchObject({ extra: [], missing: { optional: [], required: [] }, ok: true })
    expectNoLeak(await hosts.calls(), [before, pushed, after].map(run => run.stdout + run.stderr).join(""), [canary, "gh-from-shell", ...tokens])
  })

  it("pushes preview values to the Vercel preview environment from .env.preview", async () => {
    const root = await linkedProject(["vercel"], local)
    const hosts = await fakeHosts(hostEnv.vercel)
    const result = await envCommand<PushJson>(["push", "--yes", "--stage", "preview", "--only", "VITEHUB_SECRET"], root, hosts.env)
    expect(result.json).toMatchObject({ pushed: [{ name: "VITEHUB_SECRET", source: ".env.preview" }], stage: "preview", target: "preview" })
    expect((await hosts.state() as { vercel?: object }).vercel).toEqual({ preview: { VITEHUB_SECRET: "preview-secret" } })
  })
})

describe("vitehub env push value sources", () => {
  const secretOnly = [envEntries[0]!]
  const gitIn = (root: string) => (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, LC_ALL: "C" } })

  it.each(["$BASE", "${BASE}", "${UNSET:-$BASE}"])("refuses a secret that %s expands from a tracked file, though its own file is ignored", async (reference) => {
    const root = await linkedProject(["cloudflare"], { ".env": `BASE=${canary}\n`, ".env.production": `VITEHUB_SECRET=${reference}\n` })
    const git = gitIn(root)
    git("init", "-q")
    git("add", "-f", ".env")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(3)
    expect(result.json.error).toMatchObject({ code: "SETUP_ENV_FILE_TRACKED", fix: expect.stringContaining("git rm --cached .env") })
    expect(result.json.error?.why).toContain("VITEHUB_SECRET")
    expect(await hosts.calls()).toEqual([])
    expect(result.stdout + result.stderr).not.toContain(canary)
  })

  it("refuses a secret that a shell value expands from a tracked file", async () => {
    const root = await linkedProject(["cloudflare"], { ".env": `BASE=${canary}\n`, ".env.production": "VITEHUB_SECRET=$LINK\n" })
    const git = gitIn(root)
    git("init", "-q")
    git("add", "-f", ".env")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, { ...hosts.env, LINK: "$BASE" })

    expect(result.json.error?.code).toBe("SETUP_ENV_FILE_TRACKED")
    expect(await hosts.calls()).toEqual([])
  })

  it("refuses an ignored symlink to a tracked file, by the real path", async () => {
    const root = await linkedProject(["cloudflare"], { "shared/production.env": `VITEHUB_SECRET=${canary}\n` })
    await symlink(join(root, "shared/production.env"), join(root, ".env.production"))
    const git = gitIn(root)
    git("init", "-q")
    git("add", "shared/production.env")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, hosts.env)

    expect(result.exitCode).toBe(3)
    expect(result.json.error).toMatchObject({ code: "SETUP_ENV_FILE_TRACKED", fix: expect.stringContaining("git rm --cached shared/production.env") })
    expect(await hosts.calls()).toEqual([])
  })

  it("refuses a secret from a file that git does not track and does not ignore", async () => {
    const root = await linkedProject(["cloudflare"], { ".gitignore": ".output\n.vitehub\n", ".env.production": `VITEHUB_SECRET=${canary}\n` })
    gitIn(root)("init", "-q")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, hosts.env)

    expect(result.exitCode).toBe(3)
    expect(result.json.error).toMatchObject({ code: "SETUP_ENV_FILE_NOT_IGNORED", fix: expect.stringContaining(".gitignore") })
    expect(result.json.error?.why).toContain(".env.production")
    expect(await hosts.calls()).toEqual([])
  })

  it("fails closed when git cannot answer inside a repository", async () => {
    const root = await linkedProject(["cloudflare"], { ".env.production": `VITEHUB_SECRET=${canary}\n` })
    gitIn(root)("init", "-q")
    await writeFile(join(root, ".git/HEAD"), "not a ref\n")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, hosts.env)

    expect(result.exitCode).toBe(1)
    expect(result.json.error?.code).toBe("SETUP_ENV_GIT_FAILED")
    expect(await hosts.calls()).toEqual([])
    expect(result.stdout + result.stderr).not.toContain(canary)
  })

  it("pushes a secret from a file outside any git repository, with a warning", async () => {
    const root = await linkedProject(["cloudflare"], { ".env.production": `VITEHUB_SECRET=${canary}\n` })
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes", "--only", "VITEHUB_SECRET"], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain("Warning: .env.production is not in a git repository")
    expect(await hosts.state()).toMatchObject({ secrets: { VITEHUB_SECRET: canary } })
  })

  it("reads the envDir that the build recorded, as the app does", async () => {
    const files = {
      ".env.production": "VITEHUB_SECRET=from-the-root\n",
      "config/.env.production": `VITEHUB_SECRET=${canary}\n`,
      ".output/deployment.json": JSON.stringify({ env: secretOnly, envDir: "../config", host: "cloudflare", identity: { name: "my-app", source: "package" } }),
    }
    const root = await linkedProject(["cloudflare"], files)
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json.pushed).toEqual([{ name: "VITEHUB_SECRET", replaced: false, secret: true, source: "config/.env.production" }])
    expect(await hosts.state()).toMatchObject({ secrets: { VITEHUB_SECRET: canary } })

    // The tracked-file check follows envDir too.
    const git = gitIn(root)
    git("init", "-q")
    git("add", "-f", "config/.env.production")
    const tracked = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)
    expect(tracked.json.error).toMatchObject({ code: "SETUP_ENV_FILE_TRACKED", fix: expect.stringContaining("git rm --cached config/.env.production") })
  })

  it("reads no env file with envDir: false, as the app does", async () => {
    const files = {
      ".env.production": `VITEHUB_SECRET=${canary}\n`,
      ".output/deployment.json": JSON.stringify({ env: secretOnly, envDir: false, host: "cloudflare", identity: { name: "my-app", source: "package" } }),
    }
    const root = await linkedProject(["cloudflare"], files)
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const none = await envCommand<PushJson>(["push", "--yes"], root, hosts.env)
    expect(none.json).toMatchObject({ pushed: [], skipped: [{ names: ["VITEHUB_SECRET"], required: true }] })

    const shell = await envCommand<PushJson>(["push", "--yes"], root, { ...hosts.env, VITEHUB_SECRET: "from-the-shell" })
    expect(shell.json.pushed).toEqual([{ name: "VITEHUB_SECRET", replaced: false, secret: true, source: "process" }])
  })
})
