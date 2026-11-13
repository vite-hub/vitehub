import { createHmac } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { nitroCacheBypass } from "@vite-hub/internal/build/nitro-cache-bypass"
import { H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub, fakeSha } from "../../workspace/test/fake-github.ts"
import { prepareSourceGeneration } from "../../source/src/vite.ts"
import { contentPreviewCookieName, contentRefTokenParameter, defineContent, defineContentPreset, registerContentKV } from "../src/index.ts"

import type { FakeGitHub } from "../../workspace/test/fake-github.ts"
import type { ContentSourceAccess } from "../src/index.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub

const key = "11".repeat(32)
const page = (title: string) => `---\ntitle: ${title}\n---\nBody\n`
const draftBranch = "vitehub/content"
/** A branch that the CMS opens a pull request from with `publish: "pr"`. */
const publishBranch = "vitehub/publish/1a2b3c4-20261111-0000"

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-allow-"))
  enableViteHubTestMode({ root })
  cleanup.push(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { recursive: true, force: true })
  })
  fake = createFakeGitHub({ owner: "acme", repo: "docs" })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  vi.stubEnv("VITEHUB_CONTENT_KEY", key)
  vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** A Content runtime whose preset keeps the CMS draft branch private, as `cms` with a GitHub store does. */
function server() {
  const drafts = defineContentPreset({ name: "drafts", options: {}, configure: () => ({ privateBranches: [draftBranch] }) })
  const content = defineContent({ route: "public", extends: drafts, sources: { docs: github({ repo: "acme/docs", ref: "main" }) }, logger: false })
  cleanup.push(() => content.dispose())
  return content
}

const anonymous = () => new Request("https://docs.example/guide")

/** A request with the preview cookie that `content.preview.enable()` sets. */
function withPreviewCookie(): Request {
  const expires = Math.floor(Date.now() / 1000) + 600
  const signature = createHmac("sha256", Buffer.from(key, "hex")).update(`vitehub.content.preview.v1.${expires}`).digest("base64url")
  return new Request("https://docs.example/guide", { headers: { cookie: `${contentPreviewCookieName}=v1.${expires}.${signature}` } })
}

function withToken(token: string): Request {
  return new Request(`https://docs.example/guide?${contentRefTokenParameter}=${encodeURIComponent(token)}`)
}

function decision(access: ContentSourceAccess) {
  return { allowed: access.allowed, reason: access.reason }
}

/** The GitHub API calls that the fake answered, without archive downloads. */
function apiCalls() {
  return fake.requests.filter(request => !/\/tarball\/|\/tar\.gz\//.test(request.path)).length
}

/**
 * The repository of every case: `main` is published, with history. `merged` was merged into `main`. `feat/open` has
 * an open pull request, `feat/lonely` has none. `fork-*` branches stand for fork commits: GitHub serves them through
 * this repository once a fork opens a pull request.
 */
function repository() {
  const old = fake.commit("main", { "guide.md": page("Old guide") })
  fake.commit("main", { "guide.md": page("Guide") })
  fake.branch("merged", "main")
  fake.commit("merged", { "merged.md": page("Merged") })
  fake.branch("main", "merged")
  const published = fake.commit("main", { "guide.md": page("Guide v2") })
  const refs: Record<string, string> = { old, published, merged: fake.head("merged")! }
  for (const branch of ["feat/open", "feat/lonely", "feat/closed", "feat/squashed", draftBranch, publishBranch, "fork-plain", "fork-labelled", "fork-closed"]) {
    fake.branch(branch, "main")
    refs[branch] = fake.commit(branch, { "guide.md": page(`Guide on ${branch}`) })
  }
  const pulls = {
    open: fake.openPull("feat/open", "main", "Same repository"),
    draft: fake.openPull(draftBranch, "main", "Publish drafts"),
    publish: fake.openPull(publishBranch, "main", "Publish guide"),
    closed: fake.openPull("feat/closed", "main", "Rejected"),
    squashed: fake.openPull("feat/squashed", "main", "Squash merged"),
    fork: fake.openPull("fork-plain", "main", "From a fork", { fork: "mallory/docs" }),
    labelled: fake.openPull("fork-labelled", "main", "From a fork, vouched", { fork: "contributor/docs", labels: ["preview:enabled"] }),
    forkClosed: fake.openPull("fork-closed", "main", "Closed fork", { fork: "contributor/docs", labels: ["preview:enabled"] }),
  }
  fake.pulls.find(pull => pull.number === pulls.closed)!.state = "closed"
  Object.assign(fake.pulls.find(pull => pull.number === pulls.squashed)!, { state: "closed", merged: true })
  fake.pulls.find(pull => pull.number === pulls.forkClosed)!.state = "closed"
  return { refs, pulls }
}

type Case = [name: string, ref: (setup: ReturnType<typeof repository>) => string, request: () => Request, expected: { allowed: boolean, reason: string }]

/**
 * O6: the fork rule of comarkdown/comark-docs (`test/preview-auth.test.ts`), then the D3 cases. Where the template
 * differs on purpose, the case says so.
 */
const cases: Case[] = [
  // Template: authorizePreviewSha
  ["a commit that is the head of a same-repo pull request", ({ refs }) => refs["feat/open"]!, anonymous, { allowed: true, reason: "pull" }],
  ["a fork commit without the preview label", ({ refs }) => refs["fork-plain"]!, anonymous, { allowed: false, reason: "unpublished" }],
  ["a fork commit with the preview label", ({ refs }) => refs["fork-labelled"]!, anonymous, { allowed: true, reason: "label" }],
  ["a commit in the history of the published branch", ({ refs }) => refs.old!, anonymous, { allowed: true, reason: "published" }],
  ["the head commit of the published branch", ({ refs }) => refs.published!, anonymous, { allowed: true, reason: "published" }],
  ["a commit outside the published history with no pull request", ({ refs }) => refs["feat/lonely"]!, anonymous, { allowed: false, reason: "unpublished" }],
  ["an unknown commit", () => fakeSha("never pushed"), anonymous, { allowed: false, reason: "missing" }],
  // Differs: the template resolves short SHAs. A ref here is a full SHA, so one commit has one URL.
  ["a short SHA", ({ refs }) => refs["feat/open"]!.slice(0, 7), anonymous, { allowed: false, reason: "missing" }],
  // Template: resolvePullPreviewSha
  ["a same-repo pull request", ({ pulls }) => `pr/${pulls.open}`, anonymous, { allowed: true, reason: "pull" }],
  ["a fork pull request without the preview label", ({ pulls }) => `pr/${pulls.fork}`, anonymous, { allowed: false, reason: "fork" }],
  ["a fork pull request with the preview label", ({ pulls }) => `pr/${pulls.labelled}`, anonymous, { allowed: true, reason: "label" }],
  ["an unknown pull request", () => "pr/999", anonymous, { allowed: false, reason: "missing" }],
  // D3: the draft branch, and refs that the published branch does not reach.
  ["the draft branch without access", () => draftBranch, anonymous, { allowed: false, reason: "private" }],
  ["the draft branch with the preview cookie", () => draftBranch, withPreviewCookie, { allowed: true, reason: "console" }],
  ["a same-repo pull request from the draft branch", ({ pulls }) => `pr/${pulls.draft}`, anonymous, { allowed: false, reason: "private" }],
  ["the head commit of the draft branch", ({ refs }) => refs[draftBranch]!, anonymous, { allowed: false, reason: "unpublished" }],
  // D4: a pull request that the CMS opens with `publish: "pr"` holds drafts too. Only Console access or a signed link opens it.
  ["a CMS publish pull request", ({ pulls }) => `pr/${pulls.publish}`, anonymous, { allowed: false, reason: "private" }],
  ["a CMS publish pull request with the preview cookie", ({ pulls }) => `pr/${pulls.publish}`, withPreviewCookie, { allowed: true, reason: "console" }],
  ["a CMS publish branch", () => publishBranch, anonymous, { allowed: false, reason: "private" }],
  ["the head commit of a CMS publish pull request", ({ refs }) => refs[publishBranch]!, anonymous, { allowed: false, reason: "unpublished" }],
  ["a branch merged into the published branch", () => "merged", anonymous, { allowed: true, reason: "published" }],
  ["the published branch", () => "main", anonymous, { allowed: true, reason: "published" }],
  // Differs: the template renders every same-repo branch.
  ["a same-repo branch with no pull request", () => "feat/lonely", anonymous, { allowed: false, reason: "unpublished" }],
  ["a same-repo branch with an open pull request", () => "feat/open", anonymous, { allowed: true, reason: "pull" }],
  ["a branch with no pull request, with the preview cookie", () => "feat/lonely", withPreviewCookie, { allowed: true, reason: "console" }],
  ["a closed pull request that was not merged", ({ pulls }) => `pr/${pulls.closed}`, anonymous, { allowed: false, reason: "closed" }],
  ["a squash merged pull request", ({ pulls }) => `pr/${pulls.squashed}`, anonymous, { allowed: true, reason: "pull" }],
  ["a closed fork pull request, even with the label", ({ pulls }) => `pr/${pulls.forkClosed}`, anonymous, { allowed: false, reason: "closed" }],
  ["an invalid ref", () => "../etc", anonymous, { allowed: false, reason: "missing" }],
  ["an unknown branch", () => "feat/none", anonymous, { allowed: false, reason: "missing" }],
]

describe("content.sources.allow()", () => {
  it.each(cases)("%s", async (_name, ref, request, expected) => {
    const setup = repository()
    const content = server()
    const access = await content.sources.allow(ref(setup), request(), "docs")
    expect(decision(access)).toEqual(expected)
    if (!access.allowed) expect(access.error).toMatchObject({ code: "CONTENT_R0031" })
  })

  it("allows a ref with its signed link only, until the token expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    repository()
    const content = server()
    const { token, expiresAt } = await content.sources.sign(draftBranch, "docs", { maxAge: 60 })
    expect(expiresAt.getTime()).toBe(Math.floor(Date.now() / 1000) * 1000 + 60_000)

    expect(decision(await content.sources.allow(draftBranch, withToken(token), "docs"))).toEqual({ allowed: true, reason: "token" })
    // The token signs one ref.
    expect(decision(await content.sources.allow("feat/lonely", withToken(token), "docs"))).toEqual({ allowed: false, reason: "unpublished" })
    expect(decision(await content.sources.allow(draftBranch, withToken(`${token.slice(0, -2)}AA`), "docs"))).toEqual({ allowed: false, reason: "private" })

    vi.setSystemTime(Date.now() + 61_000)
    expect(decision(await content.sources.allow(draftBranch, withToken(token), "docs"))).toEqual({ allowed: false, reason: "private" })
  })

  it("expires signed links through a cached route in a Source-only app", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    repository()
    const content = server()
    const { token } = await content.sources.sign(draftBranch, "docs", { maxAge: 60 })
    const projectRoot = await mkdtemp(join(tmpdir(), "content-signed-cache-"))
    cleanup.push(() => rm(projectRoot, { recursive: true, force: true }))
    await mkdir(join(projectRoot, "server"))
    await writeFile(join(projectRoot, "server/content.ts"), "import { defineContent } from '@vite-hub/content'\nexport default defineContent({ sources: {}, route: false })")
    const handlers = await prepareSourceGeneration({ projectRoot })

    // Execute the same rule-cache seam that wraps Nitro 3's H3/ocache handler.
    const seam = nitroCacheBypass().load.handler(`\0vitehub-nitro-cache:rules:${import.meta.resolve("h3/rules/cache")}`)!
    const { cache } = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(seam).toString("base64")}`) as typeof import("h3/rules/cache")
    let reads = 0
    const app = new H3()
      .use(cache.handler({ route: "/guide", options: { maxAge: 3600, allowQuery: [contentRefTokenParameter] } }))
      .get("/guide", async (event) => {
        reads++
        const access = await content.sources.allow(draftBranch, event.req, "docs")
        if (!access.allowed) return new Response("Not Found", { status: 404 })
        const view = await content.sources.at(access.target)
        event.res.headers.set("cache-control", "public, max-age=3600, s-maxage=3600")
        return await view.get("/guide")
      })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app, hooks: { hook: (name: string, close: () => void) => { if (name === "close") cleanup.push(close) } } }
    const preview = handlers.find(handler => handler.plugin && handler.handler.endsWith("/preview.mjs"))
    if (preview) {
      const generated = (await readFile(preview.handler, "utf8")).replace('"@vite-hub/content/preview"', JSON.stringify(import.meta.resolve("@vite-hub/content/preview")))
      const { default: install } = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(generated).toString("base64")}`) as { default: (app: unknown) => void }
      install(nitroApp)
    }

    const first = await nitroApp.fetch(withToken(token))
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ data: { title: `Guide on ${draftBranch}` } })
    vi.setSystemTime(Date.now() + 61_000)
    const expired = await nitroApp.fetch(withToken(token))
    expect.soft(expired.status).toBe(404)
    expect.soft(first.headers.get("cache-control")).toBe("private, no-store")
    expect(expired.headers.get("cache-control")).toBe("private, no-store")
    expect(reads).toBe(2)
  })

  it("allows a CMS publish pull request with its signed link", async () => {
    const { pulls } = repository()
    const content = server()
    const ref = `pr/${pulls.publish}`
    const { token } = await content.sources.sign(ref, "docs")
    expect(decision(await content.sources.allow(ref, withToken(token), "docs"))).toEqual({ allowed: true, reason: "token" })
    expect(decision(await content.sources.allow(ref, anonymous(), "docs"))).toEqual({ allowed: false, reason: "private" })
  })

  it("does not take a cookie signed with another key", async () => {
    repository()
    const content = server()
    const cookie = withPreviewCookie()
    vi.stubEnv("VITEHUB_CONTENT_KEY", "22".repeat(32))
    expect(decision(await content.sources.allow(draftBranch, cookie, "docs"))).toEqual({ allowed: false, reason: "private" })
  })

  it("holds a decision for 10 minutes, so a removed label shows after that", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { pulls } = repository()
    const content = server()
    const ref = `pr/${pulls.labelled}`
    expect(decision(await content.sources.allow(ref, anonymous(), "docs"))).toEqual({ allowed: true, reason: "label" })

    fake.pulls.find(pull => pull.number === pulls.labelled)!.labels = []
    // The pull request lookup of `at()` holds 30 seconds, and the decision 10 minutes.
    vi.setSystemTime(Date.now() + 9 * 60_000)
    expect(decision(await content.sources.allow(ref, anonymous(), "docs"))).toEqual({ allowed: true, reason: "label" })
    vi.setSystemTime(Date.now() + 61_000)
    expect(decision(await content.sources.allow(ref, anonymous(), "docs"))).toEqual({ allowed: false, reason: "fork" })
  })

  it("reads the pull request again for a kept target, so it does not renew a removed label", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { pulls } = repository()
    const content = server()
    const ref = `pr/${pulls.labelled}`
    const access = await content.sources.allow(ref, anonymous(), "docs")
    if (!access.allowed) throw new Error("expected the labelled fork pull request to be public")

    fake.pulls.find(pull => pull.number === pulls.labelled)!.labels = []
    vi.setSystemTime(Date.now() + 11 * 60_000)
    expect(decision(await content.sources.allow(access.target, anonymous()))).toEqual({ allowed: false, reason: "fork" })
    expect(decision(await content.sources.allow(ref, anonymous(), "docs"))).toEqual({ allowed: false, reason: "fork" })
  })

  it("holds denials, so repeated probes cost no GitHub calls", async () => {
    const { refs } = repository()
    const content = server()
    await content.sources.allow(refs["feat/lonely"]!, anonymous(), "docs")
    const calls = apiCalls()
    await content.sources.allow(refs["feat/lonely"]!, anonymous(), "docs")
    expect(apiCalls()).toBe(calls)
  })

  it("asks GitHub nothing for an invalid ref, and no compare for an unknown commit", async () => {
    repository()
    const content = server()
    const before = fake.requests.length
    await content.sources.allow("a..b", anonymous(), "docs")
    expect(fake.requests.length).toBe(before)
    await content.sources.allow(fakeSha("never pushed"), anonymous(), "docs")
    expect(fake.requests.slice(before).some(request => request.path.includes("/compare/"))).toBe(false)
  })

  it("holds no decision when GitHub fails, and checks again on the next call", async () => {
    const { refs } = repository()
    const content = server()
    let limited = true
    fake.respond(request => limited && request.path.includes("/compare/") ? Response.json({ message: "rate limited" }, { status: 403 }) : undefined)
    await expect(content.sources.allow(refs.old!, anonymous(), "docs")).rejects.toMatchObject({ code: "CONTENT_R0032" })
    limited = false
    expect(decision(await content.sources.allow(refs.old!, anonymous(), "docs"))).toEqual({ allowed: true, reason: "published" })
  })

  it("checks the preview cookie before GitHub", async () => {
    repository()
    const content = server()
    await content.sources.allow("feat/lonely", withPreviewCookie(), "docs")
    expect(fake.requests.some(request => request.path.includes("/compare/") || request.path.endsWith("/pulls"))).toBe(false)
  })

  it("opens the commit it allowed, even after the branch moves", async () => {
    repository()
    const content = server()
    const access = await content.sources.allow("feat/open", anonymous(), "docs")
    if (!access.allowed) throw new Error("expected feat/open to be public")
    fake.commit("feat/open", { "guide.md": page("Pushed later") })
    const view = await content.sources.at(access.target)
    expect(view).toMatchObject({ source: "docs", ref: "feat/open", kind: "branch", sha: access.target.sha })
    expect((await view.get("/guide"))?.data.title).toBe("Guide on feat/open")
  })

  it("decides on a view without a second ref lookup", async () => {
    const { refs } = repository()
    const content = server()
    const view = await content.sources.at(refs.old!, "docs")
    expect(decision(await content.sources.allow(view, anonymous()))).toEqual({ allowed: true, reason: "published" })
  })
})
