import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"
import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { runContentCli } from "../src/cli.ts"
import { documents } from "../src/collections.ts"
import { contentRefTokenParameter, contentSource, defineContent, defineContentPreset, registerContentKV } from "../src/index.ts"
import { contentOperations } from "../src/operations.ts"
import { contentPreviewComment, contentPreviewCommentMarker } from "../src/preview-comment.ts"

import type { FakeGitHub } from "../../workspace/test/fake-github.ts"
import type { ContentPreviewLinks } from "../src/index.ts"
import type { ContentSourceOptions } from "../src/content-source.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
let workspaces = 0

const key = "11".repeat(32)
const page = (title: string) => `---\ntitle: ${title}\n---\nBody\n`
const publishBranch = "vitehub/publish/1a2b3c4-20261111000000-0000"

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-preview-links-"))
  enableViteHubTestMode({ root })
  cleanup.push(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { recursive: true, force: true })
  })
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

function useFake(owner: string, repo: string) {
  fake = createFakeGitHub({ owner, repo })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
}

/** Plain JSON of `previewLinks()`, as the `content.previews` operation returns it. */
function plain(links: ContentPreviewLinks) {
  return { ...links, expiresAt: links.expiresAt?.toISOString() ?? null }
}

function tokenOf(url: string): string {
  return new URL(url, "https://docs.example").searchParams.get(contentRefTokenParameter)!
}

describe("CMS publish with publish: 'pr' and previews", { timeout: 30_000 }, () => {
  // The CMS GitHub store edits the files that the github() Source of the site reads, as a docs site with the CMS does.
  const pullRequests = defineContentPreset({ name: "pull-requests", options: { workspace: "content" }, configure: options => ({ workspace: options.workspace, publish: "pr" }) })

  function cms(options: { previews?: boolean, url?: string } = {}) {
    useFake("onmax", "repo")
    fake.commit("main", { "content/posts/a.md": page("A") })
    const workspace = `preview-links-${process.pid}-${++workspaces}`
    registerWorkspace(workspace, {
      store: { provider: "github", repository: "onmax/repo", token: "token", branch: "main", root: "", refs: { published: "main", draft: "vitehub/content" } },
      rules: { "**": { write: false } },
    })
    const content = defineContent({
      extends: [pullRequests, { workspace }] as const,
      collections: { posts: documents({ path: "content/posts/**/*.md", fields: { title: z.string() }, url: options.url ?? "/posts/:id" }) },
      sources: { site: github({ repo: "onmax/repo", ref: "main", root: "content" }) },
      previews: options.previews ?? true,
      logger: false,
    })
    cleanup.push(() => content.dispose())
    return { content, posts: content.collection("posts") }
  }

  it("returns a signed /pr link that opens only that pull request", async () => {
    const { content, posts } = cms()
    await posts.save("b", { data: { title: "B" }, body: "New\n" })
    const before = Date.now()
    const first = await content.publish({ collection: "posts", ids: ["b"] })
    expect(first.pullRequest?.number).toBe(1)
    expect(first.previews).toEqual([{ collection: "posts", id: "b", url: expect.stringMatching(/^\/pr\/1\/posts\/b\?vitehub-content-token=/), expiresAt: expect.any(Date) }])
    // One hour, the default of content.preview.
    const expiresIn = first.previews![0]!.expiresAt.getTime() - before
    expect(expiresIn).toBeGreaterThan(3590_000)
    expect(expiresIn).toBeLessThanOrEqual(3600_000)

    const link = new Request(`https://docs.example${first.previews![0]!.url}`)
    expect(await content.sources.allow("pr/1", link, "site")).toMatchObject({ allowed: true, reason: "token" })
    // CMS publish branches are private, so the link without its token opens nothing.
    expect(await content.sources.allow("pr/1", new Request("https://docs.example/pr/1/posts/b"), "site")).toMatchObject({ allowed: false, reason: "private" })

    await posts.save("c", { data: { title: "C" }, body: "Other\n" })
    const second = await content.publish({ collection: "posts", ids: ["c"] })
    expect(second.pullRequest?.number).toBe(2)
    expect(await content.sources.allow("pr/2", link, "site")).toMatchObject({ allowed: false, reason: "private" })
    const otherLink = new Request(`https://docs.example/pr/2/posts/c?${contentRefTokenParameter}=${encodeURIComponent(tokenOf(first.previews![0]!.url))}`)
    expect(await content.sources.allow("pr/2", otherLink, "site")).toMatchObject({ allowed: false, reason: "private" })

    // The preview route serves the page of the pull request to the link.
    const served = await content.sources.route(link, async () => {
      const current = content.sources.current()
      return new Response(`${current?.pull?.number} ${current?.path}`)
    })
    expect(await served.text()).toBe("1 /posts/b")
    expect(served.headers.get("cache-control")).toBe("private, no-store")
  })

  it.each(["/posts/:id?lang=en", "/posts/:id#intro", "/posts/:id?lang=en#intro"])("keeps the token in the query for %s", async (url) => {
    const { content, posts } = cms({ url })
    await posts.save("b", { data: { title: "B" }, body: "New\n" })
    const result = await content.publish({ collection: "posts", ids: ["b"] })
    const link = new URL(result.previews![0]!.url, "https://docs.example")
    expect(link.pathname).toBe("/pr/1/posts/b")
    expect(link.searchParams.get("lang")).toBe(url.includes("?lang=en") ? "en" : null)
    expect(link.hash).toBe(url.includes("#intro") ? "#intro" : "")
    expect(link.searchParams.get(contentRefTokenParameter)).toBeTruthy()
    expect(await content.sources.allow("pr/1", new Request(link), "site")).toMatchObject({ allowed: true, reason: "token" })
  })

  it("returns no links without previews, and still opens the pull request without a key", async () => {
    const off = cms({ previews: false })
    await off.posts.save("b", { data: { title: "B" }, body: "" })
    const result = await off.content.publish()
    expect(result.pullRequest?.number).toBe(1)
    expect(result.previews).toBeUndefined()

    vi.stubEnv("VITEHUB_CONTENT_KEY", "")
    vi.stubEnv("NODE_ENV", "production")
    const keyless = cms()
    await keyless.posts.save("b", { data: { title: "B" }, body: "" })
    const opened = await keyless.content.publish()
    expect(opened.pullRequest?.number).toBe(1)
    expect(opened.previews).toBeUndefined()
    expect(vi.mocked(console.warn).mock.calls.some(([message]) => String(message).includes("CONTENT_R0076"))).toBe(true)
  })
})

/**
 * The docs repository: `main` has `guide.md` and `kv.md`. Pull request 1 comes from `feat/kv` in the same repository,
 * pull request 2 from a CMS publish branch, and pull request 3 from a fork without the `preview:enabled` label.
 */
function docs() {
  useFake("acme", "docs")
  fake.commit("main", { "guide.md": page("Guide"), "kv.md": page("KV") })
  for (const branch of ["feat/kv", publishBranch, "fork-kv"]) {
    fake.branch(branch, "main")
    fake.commit(branch, { "kv.md": page(`KV on ${branch}`), "new.md": page("New"), "notes.txt": "not a page\n" })
  }
  fake.openPull("feat/kv", "main", "Same repository")
  fake.openPull(publishBranch, "main", "Publish KV")
  fake.openPull("fork-kv", "main", "From a fork", { fork: "mallory/docs" })
}

function app(options: ContentSourceOptions = {}) {
  const content = defineContent({ sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main", include: "**/*.md" }), options) }, previews: true, seo: { site: "https://docs.example" }, logger: false })
  cleanup.push(() => content.dispose())
  return content
}

describe("content.sources.previewLinks()", { timeout: 30_000 }, () => {
  it("links the changed pages of a same-repository pull request without a token", async () => {
    docs()
    const links = await app().sources.previewLinks(1)
    expect(links).toMatchObject({ source: "docs", repo: "acme/docs", access: "pull", expiresAt: null, pull: { number: 1, fork: false } })
    expect(links.pages).toEqual([
      { key: "kv.md", path: "/kv", url: "https://docs.example/pr/1/kv" },
      { key: "new.md", path: "/new", url: "https://docs.example/pr/1/new" },
    ])
    expect(contentPreviewComment(plain(links))).toBe([
      contentPreviewCommentMarker,
      `**Preview** of commit \`${links.sha.slice(0, 7)}\``,
      "",
      "- [/kv](https://docs.example/pr/1/kv)",
      "- [/new](https://docs.example/pr/1/new)",
      "",
    ].join("\n"))
  })

  it("uses the Source URL pattern for changed pages", async () => {
    docs()
    const links = await app({ url: "/docs/:id" }).sources.previewLinks(1)
    expect(links.pages).toEqual([
      { key: "kv.md", path: "/docs/kv", url: "https://docs.example/pr/1/docs/kv" },
      { key: "new.md", path: "/docs/new", url: "https://docs.example/pr/1/docs/new" },
    ])
    expect(contentPreviewComment(plain(links))).toContain("- [/docs/kv](https://docs.example/pr/1/docs/kv)")
  })

  it("resolves Source URL functions with PR head data and skips null URLs", async () => {
    docs()
    const content = app({ url: ({ id, data }) => data.title === "New" ? null : `/docs/${id}/${encodeURIComponent(String(data.title))}` })
    const links = await content.sources.previewLinks(1)
    expect(links.pages).toEqual([
      { key: "kv.md", path: "/docs/kv/KV%20on%20feat%2Fkv", url: "https://docs.example/pr/1/docs/kv/KV%20on%20feat%2Fkv" },
    ])
  })

  it("signs the links of a private CMS pull request", async () => {
    docs()
    const content = app()
    const links = await content.sources.previewLinks(2, { maxAge: 7200 })
    expect(links.access).toBe("token")
    expect(links.expiresAt).toBeInstanceOf(Date)
    expect(links.pages.map(entry => entry.path)).toEqual(["/kv", "/new"])
    for (const entry of links.pages) {
      expect(entry.url).toMatch(new RegExp(`^https://docs\\.example/pr/2${entry.path}\\?${contentRefTokenParameter}=`))
      expect(await content.sources.allow("pr/2", new Request(entry.url), "docs")).toMatchObject({ allowed: true, reason: "token" })
    }
    const comment = contentPreviewComment(plain(links))
    expect(comment).toContain(`- [/kv](https://docs.example/pr/2/kv?${contentRefTokenParameter}=`)
    expect(comment).toContain(`The pull request is private, so each link has a signed token. Anyone with a link can open the preview until ${links.expiresAt!.toISOString()}. Run \`vitehub content previews comment --pr 2\` again for new links.`)
  })

  it("never signs a fork pull request without the preview label", async () => {
    docs()
    const links = await app().sources.previewLinks(3)
    expect(links).toMatchObject({ access: "fork", expiresAt: null })
    expect(links.pages.every(entry => !entry.url.includes(contentRefTokenParameter))).toBe(true)
    expect(contentPreviewComment(plain(links))).toContain("The links open after a maintainer adds the `preview:enabled` label.")
  })

  it("fails with CONTENT_R0075 for a missing pull request and CONTENT_R0079 without previews", async () => {
    docs()
    await expect(app().sources.previewLinks(99)).rejects.toMatchObject({ code: "CONTENT_R0075" })
    const off = defineContent({ sources: { docs: github({ repo: "acme/docs", ref: "main" }) }, logger: false })
    cleanup.push(() => off.dispose())
    await expect(off.sources.previewLinks(1)).rejects.toMatchObject({ code: "CONTENT_R0079" })
  })
})

describe("vitehub content previews comment", { timeout: 30_000 }, () => {
  function cli(env: Record<string, string> = {}) {
    const content = app()
    const registry = createOperationRegistry([{ operations: contentOperations }])
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ default: content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const server = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { input, operation } = operationRpcRequest(init?.body)
      const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, development: true, surface: "cli", user: null })
      return operationRpcResponse(init?.body, result)
    })
    return async (...args: string[]) => {
      let stdout = ""
      let stderr = ""
      const code = await runContentCli(args, {
        cwd: "/app",
        env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173", ...env },
        rootDir: "/app",
        stdout: { write: (chunk: string | Uint8Array) => (stdout += String(chunk), true) },
        stderr: { write: (chunk: string | Uint8Array) => (stderr += String(chunk), true) },
      }, { fetch: server })
      return { code, stdout, stderr }
    }
  }

  it("prints the comment without --post and writes nothing to GitHub", async () => {
    docs()
    const printed = await cli()("previews", "comment", "--pr", "1")
    expect(printed).toMatchObject({ code: 0, stderr: "" })
    expect(printed.stdout.startsWith(`${contentPreviewCommentMarker}\n`)).toBe(true)
    expect(printed.stdout).toContain("- [/kv](https://docs.example/pr/1/kv)")
    expect(fake.comments).toEqual([])
  })

  it("creates one marked comment, then updates it in place", async () => {
    docs()
    fake.comments.push({ body: "Looks good to me.", id: 1, issue: 2, user: "reviewer" })
    const run = cli({ VITEHUB_GITHUB_TOKEN: "token" })
    const created = await run("previews", "comment", "--pr", "2", "--post")
    expect(created).toMatchObject({ code: 0, stderr: "" })
    expect(created.stdout).toMatch(/^Created the preview comment with 2 pages: https:\/\/github\.com\/acme\/docs\/pull\/2#issuecomment-\d+\n$/)
    expect(fake.comments).toHaveLength(2)
    const marked = fake.comments[1]!
    const firstBody = marked.body
    expect(firstBody.startsWith(contentPreviewCommentMarker)).toBe(true)
    expect(firstBody).toContain(`/pr/2/kv?${contentRefTokenParameter}=`)

    fake.commit(publishBranch, { "guide.md": page("Guide on the publish branch") })
    const updated = await run("previews", "comment", "--pr", "2", "--post")
    expect(updated.code).toBe(0)
    expect(updated.stdout).toContain(`Updated the preview comment with 3 pages: https://github.com/acme/docs/pull/2#issuecomment-${marked.id}\n`)
    expect(fake.comments).toHaveLength(2)
    expect(fake.comments[0]).toMatchObject({ body: "Looks good to me." })
    expect(marked.body).not.toBe(firstBody)
    expect(marked.body).toContain("- [/guide](https://docs.example/pr/2/guide?")
    const writes = fake.requests.filter(request => request.path.includes("/comments") && request.method !== "GET").map(request => request.method)
    expect(writes).toEqual(["POST", "PATCH"])
    for (const request of fake.requests.filter(entry => entry.path.includes("/comments"))) expect(request.headers.get("authorization")).toBe("Bearer token")
  })

  it("needs VITEHUB_GITHUB_TOKEN to post", async () => {
    docs()
    const result = await cli()("previews", "comment", "--pr", "1", "--post")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("needs VITEHUB_GITHUB_TOKEN")
    expect(fake.comments).toEqual([])
  })
})
