import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { HostCliRun } from "@vite-hub/internal/host-credentials"
import type { SetupError, SetupLink, SetupLinkResult, SetupLinkStatus, SetupMissing, SetupStatus } from "../src/setup/index.ts"

const TOKEN = "test-token-7f3a9c"

interface Route {
  status?: number
  fixture: string
}

interface RecordedRequest {
  method: string
  url: string
  authorization: string | undefined
  body: unknown
}

async function fixture(name: string): Promise<string> {
  return await readFile(join(import.meta.dirname, "fixtures/host-api", name), "utf8")
}

/** A fetch that answers `METHOD url` (without the query) from a recorded response, and records each request. */
function hostApi(routes: Record<string, Route>): { fetch: typeof fetch, requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    requests.push({ authorization: headers.get("authorization") ?? undefined, body: init?.body ? JSON.parse(String(init.body)) : undefined, method, url: url.href })
    const route = routes[`${method} ${url.origin}${url.pathname}`]
    if (!route) throw new Error(`unexpected request ${method} ${url.href}`)
    return new Response(await fixture(route.fixture), { headers: { "content-type": "application/json" }, status: route.status ?? 200 })
  }
  return { fetch: fakeFetch, requests }
}

const cloudflareAccount = "023e105f4ecef8ad9ca31a8372d0c353"
const cloudflare = {
  accounts: "GET https://api.cloudflare.com/client/v4/accounts",
  create: `POST https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/workers`,
  worker: `GET https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/workers/my-app`,
}

async function cloudflareProject(files: Record<string, string> = {}): Promise<string> {
  return await createProject({ ".gitignore": "node_modules\n", "package.json": JSON.stringify({ name: "@acme/My App", type: "module" }), "vite.config.ts": viteConfig(`{ preset: "cloudflare" }`), ...files })
}

async function readLink(root: string): Promise<SetupLink> {
  return JSON.parse(await readFile(join(root, ".vitehub/link.json"), "utf8")) as SetupLink
}

/** A `wrangler` login that answers `auth token --json` and `whoami --json`, and records each call. */
function wranglerLogin(accounts: readonly { id: string, name: string }[]): { run: HostCliRun, calls: string[] } {
  const calls: string[] = []
  const run: HostCliRun = async (command, args) => {
    calls.push([command, ...args].join(" "))
    if (args[0] === "auth") return { exitCode: 0, stdout: JSON.stringify({ token: TOKEN, type: "oauth" }) }
    return { exitCode: 0, stdout: JSON.stringify({ accounts, loggedIn: true }) }
  }
  return { calls, run }
}

describe("vitehub link", () => {
  it("links an existing Cloudflare Worker and writes no secret", async () => {
    const root = await cloudflareProject({ "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "My App" }`) })
    const api = hostApi({ [cloudflare.worker]: { fixture: "cloudflare-worker.json" } })

    const { exitCode, json, loadConfig, stderr, stdout } = await runSetup<SetupLinkResult>(["link", "--json"], root, { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(loadConfig).not.toHaveBeenCalled()
    expect(json).toMatchObject({
      created: false,
      credentials: { source: "env" },
      file: ".vitehub/link.json",
      gitignore: "added",
      link: { account: { id: cloudflareAccount }, host: "cloudflare", project: { id: "e8f70fdbc8b1fb0b8ddb1af166186758", name: "my-app" }, schemaVersion: 1, verified: true },
      schemaVersion: 1,
    })
    expect(api.requests).toEqual([{ authorization: `Bearer ${TOKEN}`, body: undefined, method: "GET", url: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/workers/my-app` }])
    const file = await readFile(join(root, ".vitehub/link.json"), "utf8")
    expect(JSON.parse(file)).toEqual({ ...json.link })
    expect(new Date(json.link.linkedAt).toString()).not.toBe("Invalid Date")
    expect(file).not.toContain(TOKEN)
    expect(stdout).not.toContain(TOKEN)
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.vitehub\n")
  })

  it("uses the wrangler login and its one account when no env var is set", async () => {
    const root = await cloudflareProject()
    const api = hostApi({ [cloudflare.worker.replace("my-app", "acme-my-app")]: { fixture: "cloudflare-worker.json" } })
    const wrangler = wranglerLogin([{ id: cloudflareAccount, name: "Demo Account" }])

    const { exitCode, json, stdout } = await runSetup<SetupLinkResult>(["link", "--json"], root, {}, { fetch: api.fetch, runHostCli: wrangler.run })

    expect(exitCode).toBe(0)
    // The package.json name, normalized as the build does: `@acme/My App` deploys as `acme-my-app`.
    expect(api.requests.map(request => request.url)).toEqual([`https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/workers/acme-my-app`])
    expect(json).toMatchObject({ credentials: { source: "host-cli" } })
    expect(wrangler.calls).toEqual(["wrangler auth token --json", "wrangler whoami --json"])
    expect(stdout).not.toContain(TOKEN)
  })

  it("asks for the account when the Cloudflare token has more than one", async () => {
    const root = await cloudflareProject({ "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "my-app" }`) })
    const api = hostApi({ [cloudflare.accounts]: { fixture: "cloudflare-accounts-two.json" } })

    const { exitCode, json } = await runSetup<{ error: SetupError, missing: SetupMissing[], rerun: string }>(["link", "--json"], root, { CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: api.fetch })

    expect(exitCode).toBe(2)
    expect(json.error.code).toBe("SETUP_LINK_ACCOUNT_REQUIRED")
    expect(json.missing).toEqual([{ choices: [{ id: cloudflareAccount, name: "Demo Account" }, { id: "9a7806061c88ada191ed06f989cc3dac", name: "Team Account" }], field: "account" }])
    expect(json.rerun).toBe("vitehub link --host cloudflare --project my-app --account <id>")
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(false)

    const chosen = hostApi({ [cloudflare.worker]: { fixture: "cloudflare-worker.json" } })
    const rerun = await runSetup<SetupLinkResult>(["link", "--json", "--account", cloudflareAccount], root, { CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: chosen.fetch })
    expect(rerun.exitCode).toBe(0)
    expect(rerun.json.link.account).toEqual({ id: cloudflareAccount })
  })

  it("names the one account that the token lists", async () => {
    const root = await cloudflareProject({ "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "my-app" }`) })
    const api = hostApi({ [cloudflare.accounts]: { fixture: "cloudflare-accounts-one.json" }, [cloudflare.worker]: { fixture: "cloudflare-worker.json" } })

    const { exitCode, json } = await runSetup<SetupLinkResult>(["link", "--json"], root, { CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(json.link.account).toEqual({ id: cloudflareAccount, name: "Demo Account" })
  })

  it("exits 3 for a missing project and creates it with --create", async () => {
    const root = await cloudflareProject({ "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "my-app" }`) })
    const env = { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: TOKEN }
    const missing = hostApi({ [cloudflare.worker]: { fixture: "cloudflare-not-found.json", status: 404 } })

    const notFound = await runSetup<{ error: SetupError, rerun: string }>(["link", "--json"], root, env, { fetch: missing.fetch })
    expect(notFound.exitCode).toBe(3)
    expect(notFound.json.error).toMatchObject({ code: "SETUP_LINK_PROJECT_NOT_FOUND", fix: expect.stringContaining("vitehub link --host cloudflare --project my-app --create") })
    expect(notFound.json.rerun).toBe("vitehub link --host cloudflare --project my-app --create")
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(false)

    const api = hostApi({ [cloudflare.create]: { fixture: "cloudflare-worker-created.json" }, [cloudflare.worker]: { fixture: "cloudflare-not-found.json", status: 404 } })
    const created = await runSetup<SetupLinkResult>(["link", "--create", "--json"], root, env, { fetch: api.fetch })
    expect(created.exitCode).toBe(0)
    expect(created.json).toMatchObject({ created: true, link: { project: { id: "5b1a6c2e0d4f4c0aa7f3e9b2c1d0e8f7", name: "my-app" }, verified: true } })
    expect(api.requests.at(-1)).toMatchObject({ body: { name: "my-app" }, method: "POST" })
  })

  it("links and creates a Vercel project in the team", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "vercel", name: "my-app" }`) })
    const env = { VERCEL_TEAM_ID: "team_a1b2c3d4e5f6g7h8i9j0", VERCEL_TOKEN: TOKEN }
    const found = hostApi({ "GET https://api.vercel.com/v9/projects/my-app": { fixture: "vercel-project.json" } })

    const linked = await runSetup<SetupLinkResult>(["link", "--json"], root, env, { fetch: found.fetch })
    expect(linked.exitCode).toBe(0)
    expect(linked.json).toMatchObject({ gitignore: "no-gitignore", link: { account: { id: "team_a1b2c3d4e5f6g7h8i9j0" }, host: "vercel", project: { id: "prj_12HKQaOmR5t5Uy6vdcQsNIiZgHGB", name: "my-app" }, verified: true } })
    expect(found.requests[0]!.url).toBe("https://api.vercel.com/v9/projects/my-app?teamId=team_a1b2c3d4e5f6g7h8i9j0")

    const missing = hostApi({ "GET https://api.vercel.com/v9/projects/my-app": { fixture: "vercel-not-found.json", status: 404 } })
    expect((await runSetup(["link", "--json"], root, env, { fetch: missing.fetch })).exitCode).toBe(3)

    const create = hostApi({
      "GET https://api.vercel.com/v9/projects/my-app": { fixture: "vercel-not-found.json", status: 404 },
      "POST https://api.vercel.com/v11/projects": { fixture: "vercel-project-created.json" },
    })
    const created = await runSetup<SetupLinkResult>(["link", "--create", "--json"], root, env, { fetch: create.fetch })
    expect(created.exitCode).toBe(0)
    expect(created.json).toMatchObject({ created: true, link: { project: { id: "prj_9ZyXwVuTsRqPoNmLkJiHgFeD" } } })
    expect(create.requests[1]).toMatchObject({ body: { name: "my-app" }, url: "https://api.vercel.com/v11/projects?teamId=team_a1b2c3d4e5f6g7h8i9j0" })
  })

  it("links a Netlify site by its exact name", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "netlify", name: "my-app" }`) })
    const api = hostApi({ "GET https://api.netlify.com/api/v1/sites": { fixture: "netlify-sites.json" } })

    const { exitCode, json } = await runSetup<SetupLinkResult>(["link", "--json"], root, { NETLIFY_AUTH_TOKEN: TOKEN }, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(json.link).toMatchObject({ account: { id: "5f8a9b0c1d2e3f4a5b6c7d8e", name: "Demo Team" }, host: "netlify", project: { id: "3b2a1c0d-9e8f-4a7b-b6c5-d4e3f2a1b0c9", name: "my-app" }, verified: true })
    expect(api.requests[0]!.url).toBe("https://api.netlify.com/api/v1/sites?name=my-app&per_page=100&filter=all")

    const create = hostApi({
      "GET https://api.netlify.com/api/v1/demo-team/sites": { fixture: "netlify-sites.json" },
      "POST https://api.netlify.com/api/v1/demo-team/sites": { fixture: "netlify-site-created.json" },
    })
    const created = await runSetup<SetupLinkResult>(["link", "--project", "my-new-app", "--account", "demo-team", "--create", "--json"], root, { NETLIFY_AUTH_TOKEN: TOKEN }, { fetch: create.fetch })
    expect(created.exitCode).toBe(0)
    expect(create.requests.map(request => request.method)).toEqual(["GET", "POST"])
    expect(create.requests[1]!.body).toEqual({ name: "my-new-app" })
  })

  it("stores an unverified Deno link without calling an API", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "deno", name: "my-app" }`) })

    const { exitCode, json } = await runSetup<SetupLinkResult>(["link", "--json"], root)

    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ credentials: null, link: { host: "deno", project: { name: "my-app" }, verified: false } })
    expect(json.link.account).toBeUndefined()
  })

  it("exits 2 with the login fix when credentials are missing", async () => {
    const root = await cloudflareProject()

    const { exitCode, json, stdout } = await runSetup<{ error: SetupError, missing: SetupMissing[] }>(["link", "--json"], root)

    expect(exitCode).toBe(2)
    expect(json.error).toMatchObject({ code: "SETUP_LINK_CREDENTIALS_MISSING", fix: "Run `wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID." })
    expect(json.missing).toEqual([{ field: "CLOUDFLARE_API_TOKEN" }])
    expect(stdout.trim().split("\n")).toHaveLength(1)
  })

  it("exits 3 on the Node host and 2 when the name is an expression", async () => {
    const node = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ kv: true }") })
    const nodeRun = await runSetup<{ error: SetupError }>(["link", "--json"], node)
    expect(nodeRun.exitCode).toBe(3)
    expect(nodeRun.json.error.code).toBe("SETUP_LINK_HOST_UNSUPPORTED")

    const dynamic = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: process.env.APP }`) })
    const dynamicRun = await runSetup<{ error: SetupError, rerun: string }>(["link", "--json"], dynamic, { CLOUDFLARE_API_TOKEN: TOKEN })
    expect(dynamicRun.exitCode).toBe(2)
    expect(dynamicRun.json).toMatchObject({ error: { code: "SETUP_LINK_NAME_REQUIRED" }, rerun: "vitehub link --project <name>" })

    const unknown = await runSetup<{ error: SetupError }>(["link", "--json", "--team", "x"], node)
    expect(unknown.exitCode).toBe(1)
    expect(unknown.json.error.code).toBe("CLI_R0003")
  })

  it("never prints the token, also when the host API fails", async () => {
    const root = await cloudflareProject({ "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "my-app" }`) })
    const api = hostApi({ [cloudflare.worker]: { fixture: "cloudflare-not-found.json", status: 403 } })

    const json = await runSetup(["link", "--json"], root, { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: api.fetch })
    const human = await runSetup(["link"], root, { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: api.fetch })

    expect(json.exitCode).toBe(1)
    expect(human.exitCode).toBe(1)
    expect(json.stdout).toContain("403")
    for (const output of [json.stdout, json.stderr, human.stdout, human.stderr]) expect(output).not.toContain(TOKEN)
  })

  it("keeps a .gitignore that already ignores .vitehub", async () => {
    const root = await cloudflareProject({ ".gitignore": "dist\n/.vitehub/\n", "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "my-app" }`) })
    const api = hostApi({ [cloudflare.worker]: { fixture: "cloudflare-worker.json" } })

    const { json } = await runSetup<SetupLinkResult>(["link", "--json"], root, { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: api.fetch })

    expect(json.gitignore).toBe("present")
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("dist\n/.vitehub/\n")
  })
})

describe("vitehub unlink", () => {
  it("removes the link file and is safe to run twice", async () => {
    const root = await cloudflareProject({ "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "my-app" }`) })
    const api = hostApi({ [cloudflare.worker]: { fixture: "cloudflare-worker.json" } })
    await runSetup(["link", "--json"], root, { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: TOKEN }, { fetch: api.fetch })
    expect(await readLink(root)).toMatchObject({ host: "cloudflare" })

    const first = await runSetup(["unlink", "--json"], root)
    expect(first).toMatchObject({ exitCode: 0, json: { file: ".vitehub/link.json", removed: true, schemaVersion: 1 } })
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(false)
    expect((await runSetup(["unlink", "--json"], root)).json).toMatchObject({ removed: false })
    expect(api.requests).toHaveLength(1)
  })
})

describe("vitehub status with a link", () => {
  it("shows the link and the credential source, never the token", async () => {
    const root = await cloudflareProject({ "vite.config.ts": viteConfig(`{ preset: "cloudflare", name: "my-app" }`) })
    const env = { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: TOKEN }

    const before = await runSetup<SetupStatus & SetupLinkStatus>(["status", "--json"], root, env)
    expect(before.json.link).toBeNull()
    expect(before.json.credentials).toEqual({ accountId: cloudflareAccount, host: "cloudflare", ok: true, source: "env" })

    const api = hostApi({ [cloudflare.worker]: { fixture: "cloudflare-worker.json" } })
    await runSetup(["link", "--json"], root, env, { fetch: api.fetch })

    const after = await runSetup<SetupStatus & SetupLinkStatus>(["status", "--json"], root, env)
    expect(after.json.link).toEqual({ account: { id: cloudflareAccount }, host: "cloudflare", project: { id: "e8f70fdbc8b1fb0b8ddb1af166186758", name: "my-app" }, verified: true })
    expect(after.stdout).not.toContain(TOKEN)

    const human = await runSetup(["status"], root, env)
    expect(human.stdout).toContain("my-app on cloudflare")
    expect(human.stdout).toContain("cloudflare (env)")
    expect(human.stdout).not.toContain(TOKEN)

    const wrangler = wranglerLogin([{ id: cloudflareAccount, name: "Demo Account" }])
    const fromCli = await runSetup<SetupStatus & SetupLinkStatus>(["status", "--json"], root, {}, { runHostCli: wrangler.run })
    expect(fromCli.json.credentials).toEqual({ accountId: cloudflareAccount, host: "cloudflare", ok: true, source: "host-cli" })
    expect(fromCli.stdout).not.toContain(TOKEN)
  })

  it("reports null credentials on the Node host and the fix when they are missing", async () => {
    const node = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ kv: true }") })
    expect((await runSetup<SetupLinkStatus>(["status", "--json"], node)).json).toMatchObject({ credentials: null, link: null })

    const vercel = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "vercel" }`) })
    expect((await runSetup<SetupLinkStatus>(["status", "--json"], vercel)).json.credentials).toMatchObject({ host: "vercel", missing: ["VERCEL_TOKEN"], ok: false })
  })
})
