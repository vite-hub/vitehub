import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import process from "node:process"

import { afterEach, describe, expect, it } from "vitest"

import { fakeHosts } from "./setup-deploy-helpers.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { SetupDeploymentsOutput, SetupError, SetupLiveStatus, SetupMissing } from "../src/setup/index.ts"

const TOKEN = "test-token-5d1e8b"
const ACCOUNT = "023e105f4ecef8ad9ca31a8372d0c353"
const SITE = "3970e0fe-8564-4903-9a55-c5f8de49fb8b"
const PROJECT = "prj_12HKQaOmR5t5Uy6vdcQsNIiZgHGB"
const LIVE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

interface Route {
  fixture: string
  status?: number
  /** Changes the recorded body, such as to put in the commit of a temp repository. */
  edit?: (text: string) => string
}

interface RecordedRequest {
  method: string
  url: string
  authorization: string | undefined
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
    requests.push({ authorization: new Headers(init?.headers).get("authorization") ?? undefined, method, url: url.href })
    const route = routes[`${method} ${url.origin}${url.pathname}`]
    if (!route) throw new Error(`unexpected request ${method} ${url.href}`)
    const text = await fixture(route.fixture)
    return new Response(route.edit ? route.edit(text) : text, { headers: { "content-type": "application/json" }, status: route.status ?? 200 })
  }
  return { fetch: fakeFetch, requests }
}

const cloudflareScript = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/my-app`
function cloudflareRoutes(edit?: (text: string) => string): Record<string, Route> {
  return {
    [`GET ${cloudflareScript}/deployments`]: { fixture: "cloudflare-deployments.json" },
    [`GET ${cloudflareScript}/versions`]: { fixture: "cloudflare-versions.json", ...(edit ? { edit } : {}) },
    [`GET ${cloudflareScript}/versions/18f97339-c287-4872-9bdd-e2135c07ec12`]: { fixture: "cloudflare-version.json" },
    [`GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain`]: { fixture: "cloudflare-subdomain.json" },
  }
}

const vercelRoutes: Record<string, Route> = {
  "GET https://api.vercel.com/v6/deployments": { fixture: "vercel-deployments.json" },
  [`GET https://api.vercel.com/v9/projects/${PROJECT}`]: { fixture: "vercel-project-targets.json" },
}

const netlifyRoutes: Record<string, Route> = {
  [`GET https://api.netlify.com/api/v1/sites/${SITE}`]: { fixture: "netlify-site.json" },
  [`GET https://api.netlify.com/api/v1/sites/${SITE}/deploys`]: { fixture: "netlify-deploys.json" },
}

const links = {
  cloudflare: { account: { id: ACCOUNT }, host: "cloudflare", linkedAt: "2026-11-06T00:00:00.000Z", project: { name: "my-app" }, schemaVersion: 1, verified: true },
  deno: { account: { id: "acme" }, host: "deno", linkedAt: "2026-11-06T00:00:00.000Z", project: { name: "my-app" }, schemaVersion: 1, verified: false },
  netlify: { account: { id: "5e2e4fce8b2a3b0c00a1b2c3" }, host: "netlify", linkedAt: "2026-11-06T00:00:00.000Z", project: { id: SITE, name: "my-app" }, schemaVersion: 1, verified: true },
  vercel: { account: { id: "team_LLHUOMOoDlqOp8wPE4kFo9pE" }, host: "vercel", linkedAt: "2026-11-06T00:00:00.000Z", project: { id: PROJECT, name: "my-app" }, schemaVersion: 1, verified: true },
} as const

const credentials = {
  cloudflare: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
  deno: { DENO_DEPLOY_TOKEN: TOKEN },
  netlify: { NETLIFY_AUTH_TOKEN: TOKEN },
  vercel: { VERCEL_TOKEN: TOKEN },
} as const

type Host = keyof typeof links

function projectFiles(host: Host, linked = true): Record<string, string> {
  return {
    ".gitignore": ".vitehub\n",
    "package.json": JSON.stringify({ name: "my-app", type: "module" }),
    "vite.config.ts": `import { defineConfig } from "vite"\nimport { vitehub } from "vite-hub"\n\nexport default defineConfig({ plugins: [vitehub({ preset: "${host}" })] })\n`,
    ...(linked ? { ".vitehub/link.json": JSON.stringify(links[host]) } : {}),
  }
}

const gitDirs: string[] = []
afterEach(async () => {
  await Promise.all(gitDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) }

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=ViteHub", "-c", "user.email=test@vitehub.dev", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env: gitEnv }).trim()
}

/** A project in a temp git repository under /dev/shm, with `commits` commits. Returns the root and each commit sha. */
async function gitProject(host: Host, commits: number): Promise<{ root: string, shas: string[] }> {
  const root = await mkdtemp(join(process.platform === "linux" ? "/dev/shm" : (process.env.TMPDIR ?? "/tmp"), "vitehub-deployments-"))
  gitDirs.push(root)
  for (const [file, content] of Object.entries(projectFiles(host))) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }
  git(root, ["init", "-q", "-b", "main"])
  const shas: string[] = []
  for (let index = 0; index < commits; index++) {
    await writeFile(join(root, "file.txt"), `${index}\n`)
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", `commit ${index}`])
    shas.push(git(root, ["rev-parse", "HEAD"]))
  }
  return { root, shas }
}

/** The Cloudflare versions fixture with the live version marked with `sha`. */
function liveCommit(sha: string): (text: string) => string {
  return text => text.replaceAll(LIVE_SHA, sha)
}

describe("vitehub deployments", () => {
  it("lists Cloudflare deployments and previews from the Workers API, newest first", async () => {
    const root = await createProject(projectFiles("cloudflare"))
    const api = hostApi(cloudflareRoutes())

    const { exitCode, json, stderr, loadConfig } = await runSetup<SetupDeploymentsOutput & { schemaVersion: number }>(["deployments", "--json"], root, credentials.cloudflare, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(loadConfig).not.toHaveBeenCalled()
    expect(json).toEqual({
      deployments: [
        {
          commit: { dirty: true, from: "vitehub", sha: "cccccccccccccccccccccccccccccccccccccccc" },
          createdAt: "2026-11-06T08:00:00.000Z",
          id: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d",
          live: false,
          source: "cli",
          state: "ready",
          target: "preview",
          url: "https://6a5b4c3d-my-app.example.workers.dev",
          version: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d",
        },
        {
          commit: { dirty: false, from: "vitehub", sha: LIVE_SHA },
          createdAt: "2026-11-05T18:11:19.117Z",
          id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
          live: true,
          source: "cli",
          state: "ready",
          target: "production",
          url: "https://my-app.example.workers.dev",
          version: "bcf48806-b317-4351-9ee7-36e7d557d4de",
        },
        {
          createdAt: "2026-11-04T09:00:00.000Z",
          id: "4d3a7b2c-1f0e-4c8d-9b6a-5e4f3d2c1b0a",
          live: false,
          source: "dashboard",
          state: "ready",
          target: "production",
          version: "18f97339-c287-4872-9bdd-e2135c07ec12",
        },
      ],
      host: "cloudflare",
      project: { name: "my-app" },
      schemaVersion: 1,
    })
    expect(api.requests.every(request => request.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(api.requests.some(request => request.url.includes(TOKEN))).toBe(false)
    expect(api.requests.find(request => request.url.includes("/versions?"))?.url).toContain("deployable=true")
  })

  it("lists Vercel deployments and marks the production target as live", async () => {
    const root = await createProject(projectFiles("vercel"))
    const api = hostApi(vercelRoutes)

    const { exitCode, json } = await runSetup<SetupDeploymentsOutput>(["deployments", "--limit", "3", "--json"], root, credentials.vercel, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(json.deployments).toEqual([
      { commit: { dirty: true, from: "vitehub", sha: "cccccccccccccccccccccccccccccccccccccccc" }, createdAt: "2026-11-06T08:00:00.000Z", id: "dpl_3pReview", live: false, source: "cli", state: "ready", target: "preview", url: "https://my-app-3preview-acme.vercel.app" },
      { commit: { dirty: false, from: "host", sha: LIVE_SHA }, createdAt: "2026-11-05T08:00:00.000Z", id: "dpl_2euZBFqxYdDMDG1jTrHFnNZ2eUVa", live: true, source: "git", state: "ready", target: "production", url: "https://my-app-9jaeg38me-acme.vercel.app" },
      { createdAt: "2026-11-04T08:00:00.000Z", id: "dpl_1failed", live: false, source: "cli", state: "error", target: "production", url: "https://my-app-1failed-acme.vercel.app" },
    ])
    const list = new URL(api.requests.find(request => request.url.includes("/v6/deployments"))!.url)
    expect(Object.fromEntries(list.searchParams)).toEqual({ limit: "3", projectId: PROJECT, teamId: "team_LLHUOMOoDlqOp8wPE4kFo9pE" })
  })

  it("lists Netlify deploys and marks the published deploy as live", async () => {
    const root = await createProject(projectFiles("netlify"))
    const api = hostApi(netlifyRoutes)

    const { exitCode, json, stdout } = await runSetup<SetupDeploymentsOutput>(["deployments", "--json"], root, credentials.netlify, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(json.deployments).toEqual([
      { commit: { dirty: false, from: "host", sha: "dddddddddddddddddddddddddddddddddddddddd" }, createdAt: "2026-11-06T08:00:00.000Z", id: "7654321fedcba9876543210f", live: false, source: "git", state: "building", target: "preview", url: "https://7654321fedcba9876543210f--my-app.netlify.app" },
      { commit: { dirty: false, from: "vitehub", sha: LIVE_SHA }, createdAt: "2026-11-05T18:00:00.000Z", id: "6543210fedcba9876543210f", live: true, source: "cli", state: "ready", target: "production", url: "https://6543210fedcba9876543210f--my-app.netlify.app" },
    ])
    expect(stdout).not.toContain(TOKEN)
    expect(new URL(api.requests.find(request => request.url.includes("/deploys"))!.url).searchParams.get("per_page")).toBe("10")
  })

  it("lists Deno deployments through the deno CLI with the token only in the environment", async () => {
    const root = await createProject(projectFiles("deno"))
    const hosts = await fakeHosts({
      ...credentials.deno,
      FAKE_DENO_APP: JSON.stringify({ id: "app-1", org: "acme", productionRevisionId: "rev-2", productionUrl: "https://my-app.acme.deno.net", slug: "my-app" }),
      FAKE_DENO_DEPLOYMENTS: JSON.stringify({ app: "my-app", items: [
        { createdAt: "2026-11-06T08:00:00.000Z", id: "rev-3", lastStep: "build", prod: false, status: "building", updatedAt: "2026-11-06T08:00:00.000Z" },
        { createdAt: "2026-11-05T08:00:00.000Z", id: "rev-2", lastStep: "routed", prod: true, status: "succeeded", updatedAt: "2026-11-05T08:01:00.000Z" },
        { createdAt: "2026-11-04T08:00:00.000Z", id: "rev-1", lastStep: "build", prod: true, status: "failed", updatedAt: "2026-11-04T08:01:00.000Z" },
      ], nextCursor: null, org: "acme" }),
    })

    const { exitCode, json, stdout } = await runSetup<SetupDeploymentsOutput>(["deployments", "--limit", "5", "--json"], root, hosts.env)

    expect(exitCode).toBe(0)
    expect(json.deployments).toEqual([
      { createdAt: "2026-11-06T08:00:00.000Z", id: "rev-3", live: false, source: "unknown", state: "building", target: "preview" },
      { createdAt: "2026-11-05T08:00:00.000Z", id: "rev-2", live: true, source: "unknown", state: "ready", target: "production", url: "https://my-app.acme.deno.net" },
      { createdAt: "2026-11-04T08:00:00.000Z", id: "rev-1", live: false, source: "unknown", state: "error", target: "production" },
    ])
    const calls = await hosts.calls()
    expect(calls.map(call => call.argv.slice(0, 3).join(" ")).toSorted()).toEqual(["deploy apps get", "deploy deployments list"])
    expect(calls.find(call => call.argv[1] === "deployments")?.argv).toEqual(["deploy", "deployments", "list", "--limit", "5", "--json", "--non-interactive", "--org", "acme", "--app", "my-app"])
    for (const call of calls) expect(call.argv.join(" ")).not.toContain(TOKEN)
    expect(stdout).not.toContain(TOKEN)
  })

  it("prints a short table", async () => {
    const root = await createProject(projectFiles("cloudflare"))

    const { exitCode, stdout } = await runSetup(["deployments"], root, credentials.cloudflare, { fetch: hostApi(cloudflareRoutes()).fetch })

    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^ +id +target +state +commit +created +url$/mu)
    expect(stdout).toMatch(/^live +182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e +production +ready +bbbbbbb +2026-11-05T18:11:19\.117Z +https:\/\/my-app\.example\.workers\.dev$/mu)
    expect(stdout).toMatch(/6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d +preview +ready +ccccccc \(dirty\)/u)
  })

  it("exits with 2 and a `vitehub link` rerun when the project has no link", async () => {
    const root = await createProject(projectFiles("cloudflare", false))

    const { exitCode, json } = await runSetup<{ error: SetupError, missing: SetupMissing[], rerun: string }>(["deployments", "--json"], root, credentials.cloudflare)

    expect(exitCode).toBe(2)
    expect(json.error.code).toBe("SETUP_DEPLOYMENTS_NOT_LINKED")
    expect(json.rerun).toBe("vitehub link")
  })

  it("exits with 2 and the credential fix when no credentials resolve", async () => {
    const root = await createProject(projectFiles("vercel"))

    const { exitCode, json } = await runSetup<{ error: SetupError, missing: SetupMissing[] }>(["deployments", "--json"], root)

    expect(exitCode).toBe(2)
    expect(json.error.code).toBe("SETUP_DEPLOYMENTS_CREDENTIALS_MISSING")
    expect(json.error.fix).toContain("VERCEL_TOKEN")
    expect(json.missing).toEqual([{ field: "VERCEL_TOKEN" }])
  })

  it("exits with 2 when a Netlify link has no site id", async () => {
    const root = await createProject({ ...projectFiles("netlify"), ".vitehub/link.json": JSON.stringify({ ...links.netlify, project: { name: "my-app" } }) })

    const { exitCode, json } = await runSetup<{ error: SetupError, rerun: string }>(["deployments", "--json"], root, credentials.netlify)

    expect(exitCode).toBe(2)
    expect(json.error.code).toBe("SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED")
    expect(json.rerun).toBe("vitehub link --host netlify")
  })

  it("exits with 1 when the host API fails, and rejects a bad --limit", async () => {
    const root = await createProject(projectFiles("vercel"))
    const api = hostApi({ ...vercelRoutes, "GET https://api.vercel.com/v6/deployments": { fixture: "vercel-not-found.json", status: 403 } })

    const failed = await runSetup<{ error: SetupError }>(["deployments", "--json"], root, credentials.vercel, { fetch: api.fetch })
    expect(failed.exitCode).toBe(1)
    expect(failed.json.error.why).toContain("/v6/deployments (403)")

    const bad = await runSetup<{ error: SetupError }>(["deployments", "--limit", "0", "--json"], root, credentials.vercel)
    expect(bad.exitCode).toBe(1)
    expect(bad.json.error.code).toBe("CLI_R0003")
  })
})

describe("vitehub status live", () => {
  it("reports the live commit as 2 commits behind HEAD", async () => {
    const { root, shas } = await gitProject("cloudflare", 3)
    const api = hostApi(cloudflareRoutes(liveCommit(shas[0]!)))

    const { exitCode, json } = await runSetup<SetupLiveStatus>(["status", "--json"], root, { ...gitEnv, ...credentials.cloudflare }, { fetch: api.fetch })
    const human = await runSetup(["status"], root, { ...gitEnv, ...credentials.cloudflare }, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(json.liveReason).toBeNull()
    expect(json.live).toEqual({ ahead: 0, behind: 2, commit: { dirty: false, sha: shas[0] }, deploymentId: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", url: "https://my-app.example.workers.dev" })
    expect(human.stdout).toMatch(new RegExp(`^live +${shas[0]!.slice(0, 7)} \\(2 commits behind\\) https://my-app\\.example\\.workers\\.dev$`, "mu"))
  })

  it("reports ahead when HEAD is behind the live commit, and up to date on the same commit", async () => {
    const { root, shas } = await gitProject("vercel", 2)
    const routes = (sha: string) => ({ ...vercelRoutes, "GET https://api.vercel.com/v6/deployments": { edit: liveCommit(sha), fixture: "vercel-deployments.json" } })
    git(root, ["checkout", "-q", shas[0]!])

    const ahead = await runSetup<SetupLiveStatus>(["status", "--json"], root, { ...gitEnv, ...credentials.vercel }, { fetch: hostApi(routes(shas[1]!)).fetch })
    expect(ahead.json.live).toMatchObject({ ahead: 1, behind: 0, deploymentId: "dpl_2euZBFqxYdDMDG1jTrHFnNZ2eUVa" })

    const same = await runSetup(["status"], root, { ...gitEnv, ...credentials.vercel }, { fetch: hostApi(routes(shas[0]!)).fetch })
    expect(same.stdout).toMatch(/^live +[0-9a-f]{7} \(up to date\)/mu)
  })

  it("reports commit-not-local, no-marker, and no-git", async () => {
    const { root } = await gitProject("netlify", 1)
    const notLocal = await runSetup<SetupLiveStatus>(["status", "--json"], root, { ...gitEnv, ...credentials.netlify }, { fetch: hostApi(netlifyRoutes).fetch })
    expect(notLocal.json.live).toEqual({ commit: { dirty: false, sha: LIVE_SHA }, deploymentId: "6543210fedcba9876543210f", unknownReason: "commit-not-local", url: "https://6543210fedcba9876543210f--my-app.netlify.app" })

    const deno = await gitProject("deno", 1)
    const hosts = await fakeHosts({ ...credentials.deno, FAKE_DENO_APP: JSON.stringify({ productionRevisionId: "rev-2", productionUrl: "https://my-app.acme.deno.net" }), FAKE_DENO_DEPLOYMENTS: JSON.stringify({ items: [{ createdAt: "2026-11-05T08:00:00.000Z", id: "rev-2", prod: true, status: "succeeded" }] }) })
    const noMarker = await runSetup<SetupLiveStatus>(["status", "--json"], deno.root, hosts.env)
    expect(noMarker.json.live).toEqual({ deploymentId: "rev-2", unknownReason: "no-marker", url: "https://my-app.acme.deno.net" })
    const human = await runSetup(["status"], deno.root, hosts.env)
    expect(human.stdout).toMatch(/^live +rev-2 \(no commit marker\) https:\/\/my-app\.acme\.deno\.net$/mu)

    const plain = await createProject(projectFiles("netlify"))
    const noGit = await runSetup<SetupLiveStatus>(["status", "--json"], plain, { ...gitEnv, ...credentials.netlify }, { fetch: hostApi(netlifyRoutes).fetch })
    expect(noGit.json.live).toMatchObject({ commit: { sha: LIVE_SHA }, unknownReason: "no-git" })
  })

  it("keeps exit 0 with liveReason on a network error, a slow host, no link, or no credentials", async () => {
    const root = await createProject(projectFiles("cloudflare"))
    const down = await runSetup<SetupLiveStatus>(["status", "--json"], root, credentials.cloudflare, { fetch: async () => { throw new TypeError("fetch failed") } })
    expect(down.exitCode).toBe(0)
    expect(down.json).toMatchObject({ live: null, liveReason: "host-error" })

    // A host that never answers until the request is aborted.
    const hang: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
    })
    const started = Date.now()
    const slow = await runSetup<SetupLiveStatus>(["status", "--json"], root, credentials.cloudflare, { fetch: hang })
    expect(slow.exitCode).toBe(0)
    expect(slow.json).toMatchObject({ live: null, liveReason: "timeout" })
    expect(Date.now() - started).toBeLessThan(15_000)

    const noCredentials = await runSetup<SetupLiveStatus>(["status", "--json"], root)
    expect(noCredentials.json).toMatchObject({ live: null, liveReason: "no-credentials" })

    const unlinked = await runSetup<SetupLiveStatus>(["status", "--json"], await createProject(projectFiles("cloudflare", false)), credentials.cloudflare)
    expect(unlinked.json).toMatchObject({ live: null, liveReason: "not-linked" })
    const human = await runSetup(["status"], root, credentials.cloudflare, { fetch: async () => { throw new TypeError("fetch failed") } })
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toMatch(/^live +unknown \(the host request failed; run `vitehub deployments` for the error\)$/mu)
  }, 20_000)

  it("skips the host with --offline", async () => {
    const root = await createProject(projectFiles("cloudflare"))
    const api = hostApi(cloudflareRoutes())

    const { exitCode, json } = await runSetup<SetupLiveStatus>(["status", "--offline", "--json"], root, credentials.cloudflare, { fetch: api.fetch })
    const human = await runSetup(["status", "--offline"], root, credentials.cloudflare, { fetch: api.fetch })

    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ live: null, liveReason: "offline" })
    expect(api.requests).toEqual([])
    expect(human.stdout).toMatch(/^live +not checked \(--offline\)$/mu)
  })
})
