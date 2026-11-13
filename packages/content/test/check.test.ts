import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { kv } from "@vite-hub/kv"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"
import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { runContentCli } from "../src/cli.ts"
import { contentSource, defineContent, registerContentKV } from "../src/index.ts"
import { contentOperations } from "../src/operations.ts"

import type { ContentCheckResult, ContentSourceOptions } from "../src/index.ts"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub

const description = "A description that is long enough for the search rules of the check, at seventy characters or more."
/** A page that passes every rule. */
const page = (title: string, body = "Body\n") => `---\ntitle: ${title}\ndescription: ${description} ${title}\n---\n${body}`

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-check-"))
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
  vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function server(options: Parameters<typeof defineContent>[0] = {}, schema?: ContentSourceOptions["schema"]) {
  const content = defineContent({ route: "public", sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id", ...(schema ? { schema } : {}) }) }, logger: false, ...options })
  cleanup.push(() => content.dispose())
  return content
}

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

async function cli(cwd: string, args: string[], fetch?: typeof globalThis.fetch) {
  const stdout = stream()
  const stderr = stream()
  const code = await runContentCli(["check", ...args], { cwd, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" }, rootDir: cwd, stderr, stdout }, fetch ? { fetch } : {})
  return { code, stdout: stdout.output(), stderr: stderr.output() }
}

describe("content.sources.advance() with the check", { timeout: 30_000 }, () => {
  const targetMappings = [
    { mapping: "prefix", url: "/blog/:id", key: "post.md" },
    { mapping: "no URL", url: undefined, key: "blog/post.md" },
    { mapping: "root pattern", url: "/:id", key: "blog/post.md" },
    { mapping: "function", url: ({ id }: { id: string }) => `/${id}`, key: "blog/post.md" },
  ]

  it.each(targetMappings)("keeps a failed linked Source from weakening selected checks, advances, and pins ($mapping)", async ({ url, key }) => {
    let unavailable = false
    const first = fake.commit("main", { "docs/guide.md": page("Getting started") })
    const content = server({ sources: {
      docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }),
      blog: contentSource({ items: async () => {
        if (unavailable) throw new Error("Reader unavailable")
        return [{ key, content: page("Blog introduction") }]
      } }, { url }),
    } })
    expect((await content.sources.head("docs")).sha).toBe(first)
    const bad = fake.commit("main", { "docs/guide.md": page("Updated guide", "See [missing](/blog/missing).\n") })
    expect(await content.check({ source: "docs" })).toMatchObject({ ok: false, errors: 1, findings: [{ code: "CONTENT_R0062" }] })

    unavailable = true
    await expect(content.check({ source: "docs" })).rejects.toMatchObject({ code: "CONTENT_R0069" })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: first, rejected: { sha: bad, reason: expect.stringContaining('Source "blog"') } })
    await expect(content.sources.pin(bad, "docs")).rejects.toMatchObject({ code: "CONTENT_R0019" })
    // Valid links into the unavailable namespace also require a successful dependency check.
    const valid = fake.commit("main", { "docs/guide.md": page("Updated guide", "See [post](/blog/post).\n") })
    await expect(content.check({ source: "docs" })).rejects.toMatchObject({ code: "CONTENT_R0069" })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: first, rejected: { sha: valid } })

    unavailable = false
    expect(await content.check({ source: "docs" })).toMatchObject({ ok: true, warnings: 0 })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: valid, rejected: null })
    await expect(content.sources.pin(bad, "docs")).rejects.toMatchObject({ code: "CONTENT_R0019" })
  })

  it.each([
    ...targetMappings.map(target => ({ ...target, kind: "reader" })),
    { mapping: "GitHub", kind: "github", url: "/blog/:id" },
  ])("does not initialize a head with links into an unavailable Source ($mapping)", async ({ kind, url }) => {
    fake.commit("main", { "docs/guide.md": page("Getting started", "See [missing](/blog/missing).\n") })
    fake.commit("blog", { "post.md": page("Blog introduction") })
    fake.respond(request => request.path.endsWith("/commits/blog") ? new Response("rate limited", { status: 429 }) : undefined)
    const content = server({ sources: {
      docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }),
      blog: contentSource(kind === "github" ? github({ repo: "acme/docs", ref: "blog", auth: false }) : { items: async () => { throw new Error("Reader unavailable") } }, { url }),
    } })
    expect(await content.sources.head("docs")).toMatchObject({ sha: null, rejected: { reason: expect.stringContaining('Source "blog"') } })
    await expect(content.check({ source: "docs" })).rejects.toMatchObject({ code: "CONTENT_R0069" })
  })

  it.each(targetMappings.flatMap(({ mapping, url }) => [
    "Body\n",
    "See [setup](/docs/setup#installation).\n",
    "See [ignored](/blog/missing) and [external](https://example.com/missing).\n",
  ].map(body => ({ mapping, url, body }))))("isolates an unavailable target Source when checking $body ($mapping)", async ({ url, body }) => {
    const first = fake.commit("main", { "docs/guide.md": page("Getting started", body) })
    const generated = [{ key: "docs/setup.md", content: page("Project setup", "## Installation\n") }]
    const content = server({ sources: {
      docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }),
      generated: contentSource({ items: async () => generated }, { url: "/:id" }),
      unavailable: contentSource({ items: async () => { throw new Error("Reader unavailable") } }, { url }),
    }, check: { ignoreLinks: ["/blog/missing"] } })

    expect((await content.sources.head("docs")).sha).toBe(first)
    expect(await content.list("docs")).toHaveLength(1)
    expect(await content.check({ source: "docs" })).toMatchObject({ ok: true, warnings: 0 })
    const next = fake.commit("main", { "docs/guide.md": page("Updated guide", body) })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: next, rejected: null })
    expect(await content.sources.pin(first, "docs")).toMatchObject({ sha: first, rejected: null })
    // A Source explicitly selected for checking must still report its retrieval failure.
    await expect(content.check({ source: "unavailable" })).rejects.toThrow("Reader unavailable")
    await expect(content.check()).rejects.toThrow("Reader unavailable")
    if (url === "/blog/:id" && body.includes("[setup]")) {
      generated.splice(0)
      expect(await content.check({ source: "docs" })).toMatchObject({ ok: false, errors: 1 })
    }
  })

  it("keeps head changes and selected checks usable when an unrelated GitHub Source is rate limited", async () => {
    const first = fake.commit("main", { "docs/guide.md": page("Getting started") })
    fake.commit("blog", { "post.md": page("Blog introduction") })
    fake.respond(request => request.path.endsWith("/commits/blog") ? new Response("rate limited", { status: 429 }) : undefined)
    const content = server({ sources: {
      docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }),
      blog: contentSource(github({ repo: "acme/docs", ref: "blog", auth: false }), { url: "/blog/:id" }),
    } })

    expect((await content.sources.head("docs")).sha).toBe(first)
    expect(await content.check({ source: "docs" })).toMatchObject({ ok: true, warnings: 0 })
    const next = fake.commit("main", { "docs/guide.md": page("Updated guide") })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: next, rejected: null })
    expect(await content.sources.pin(first, "docs")).toMatchObject({ sha: first, rejected: null })
    await expect(content.check({ source: "blog" })).rejects.toMatchObject({ code: "CONTENT_R0069" })
  })

  it("resolves links and headings across Sources for checks, initial heads, advances, and pins", async () => {
    const generated = [{ key: "docs/setup.md", path: "docs/setup.md", content: page("Project setup", "## Installation\n") }]
    const first = fake.commit("main", { "docs/guide.md": page("Getting started", "See [setup](/docs/setup#installation).\n") })
    const content = server({ sources: {
      docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }),
      generated: contentSource({ items: async () => generated }, { url: "/:id" }),
    } })
    expect(await content.check()).toMatchObject({ ok: true, errors: 0, warnings: 0, sources: [{ source: "docs", pages: 1 }, { source: "generated", pages: 1 }] })
    expect(await content.check({ source: "docs" })).toMatchObject({ ok: true, warnings: 0 })
    expect((await content.sources.head("docs")).sha).toBe(first)
    expect(await content.get("/docs/setup")).toBeTruthy()

    const next = fake.commit("main", { "docs/guide.md": page("Updated guide", "See [setup](/docs/setup#installation).\n") })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: next, rejected: null })
    expect(await content.sources.pin(first, "docs")).toMatchObject({ sha: first, rejected: null })

    generated.splice(0)
    expect(await content.check({ source: "docs" })).toMatchObject({ ok: false, errors: 1 })
  })

  it("uses the other GitHub Source's published head for a gate and selected checks", async () => {
    const docs = fake.commit("main", { "docs/guide.md": page("Getting started", "See [setup](/docs/setup#installation).\n") })
    const generated = fake.commit("generated", { "docs/setup.md": page("Project setup", "## Installation\n") })
    const content = server({ sources: {
      docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }),
      generated: contentSource(github({ repo: "acme/docs", ref: "generated" }), { url: "/:id" }),
    } })
    expect(await content.check()).toMatchObject({ ok: true, warnings: 0 })
    expect((await content.sources.head("generated")).sha).toBe(generated)
    await content.sources.pin(generated, "generated")
    fake.commit("generated", { "docs/setup.md": null })
    expect(await content.check({ source: "docs" })).toMatchObject({ ok: true, warnings: 0 })
    expect((await content.sources.head("docs")).sha).toBe(docs)
    // Aggregate checks inspect both branch candidates, even when one published head is pinned.
    expect(await content.check()).toMatchObject({ ok: false, errors: 1 })
  })

  it("does not use the previous head to resolve a page removed by the candidate commit", async () => {
    const first = fake.commit("main", { "docs/setup.md": page("Project setup") })
    const content = server({ sources: {
      docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }),
      generated: contentSource({ items: async () => [{ key: "extra.md", content: page("Extra document") }] }, { url: "/:id" }),
    } })
    expect((await content.sources.head("docs")).sha).toBe(first)
    const bad = fake.commit("main", { "docs/setup.md": null, "docs/guide.md": page("Getting started", "See [setup](/docs/setup).\n") })
    expect(await content.check()).toMatchObject({ ok: false, errors: 1 })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: first, rejected: { sha: bad } })
  })

  it("keeps the head when a push links to a page that does not exist", async () => {
    const first = fake.commit("main", { "docs/guide.md": page("Getting started") })
    const content = server()
    expect((await content.sources.head("docs")).sha).toBe(first)

    const bad = fake.commit("main", { "docs/guide.md": page("Getting started", "Intro\n\nRead [the setup](/docs/setup) first.\n") })
    const head = await content.sources.advance("docs")

    expect(head.sha).toBe(first)
    expect(head.rejected).toMatchObject({ sha: bad })
    expect(head.rejected!.reason).toBe("1 check error: docs/guide.md:7: /docs/guide links to /docs/setup, which is no page of Source \"docs\". Fix the link, or add the path to `check.ignoreLinks` when another route serves it. (CONTENT_R0062). `vitehub content check` lists them all.")
    expect(head.diagnostic).toMatchObject({ code: "CONTENT_R0019" })

    const fixed = fake.commit("main", { "docs/setup.md": page("Set up the project") })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: fixed, rejected: null })
  })

  it("moves the head when a push has only warnings", async () => {
    fake.commit("main", { "guide.md": page("Getting started") })
    const content = server()
    await content.sources.head("docs")

    // A short title, no description, a link to a missing heading, and a link to a route outside the pages are warnings.
    const warned = fake.commit("main", { "guide.md": "---\ntitle: Guide\n---\nSee [the end](#missing) and [the playground](/playground).\n" })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: warned, rejected: null, diagnostic: null })

    const result = await content.check()
    expect(result).toMatchObject({ ok: true, errors: 0, warnings: 4, sources: [{ source: "docs", sha: warned, pages: 1 }] })
    expect(result.findings.map(finding => [finding.rule, finding.severity, finding.code, finding.line])).toEqual([
      ["description", "warning", "CONTENT_R0066", null],
      ["title", "warning", "CONTENT_R0065", 2],
      ["anchor", "warning", "CONTENT_R0064", 4],
      ["route", "warning", "CONTENT_R0063", 4],
    ])
  })

  it("keeps the head when frontmatter does not match the Source schema", async () => {
    const schema = { type: "object", properties: { title: { type: "string" }, order: { type: "number" } }, required: ["title"] } satisfies ContentSourceOptions["schema"]
    const first = fake.commit("main", { "guide.md": page("Getting started") })
    const content = server({}, schema)
    expect((await content.sources.head("docs")).sha).toBe(first)

    const bad = fake.commit("main", { "guide.md": `---\ntitle: Getting started\ndescription: ${description}\norder: first\n---\nBody\n` })
    const head = await content.sources.advance("docs")
    expect(head).toMatchObject({ sha: first, rejected: { sha: bad, reason: expect.stringContaining("guide.md:4: Expected number, received string for property \"order\". Fix the frontmatter to match the schema of Source \"docs\". (CONTENT_R0061)") } })

    const checked = await content.check({ sha: bad })
    expect(checked).toMatchObject({ ok: false, errors: 1, sources: [{ source: "docs", sha: bad }] })
    expect(checked.findings[0]).toMatchObject({ source: "docs", path: "guide.md", url: "/guide", line: 4, rule: "frontmatter", severity: "error", code: "CONTENT_R0061" })
  })

  it("skips link targets of defineContent({ check: { ignoreLinks } }), and checks absolute links to the site", async () => {
    fake.commit("main", { "docs/guide.md": page("Getting started", "See [errors](/docs/kv/diagnostics/kv_r0001), [the API](/api/content), and [the site](https://acme.dev/docs/guide).\n") })
    const content = server({ check: { ignoreLinks: ["/docs/*/diagnostics/**", "/api/**"] }, seo: { site: "https://acme.dev" } })
    expect(await content.check()).toMatchObject({ ok: true, errors: 0, warnings: 0 })

    fake.commit("main", { "docs/guide.md": page("Getting started", "See [the site](https://acme.dev/docs/missing).\n") })
    expect((await content.check()).findings).toEqual([expect.objectContaining({ rule: "link", line: 5, message: expect.stringContaining("/docs/guide links to /docs/missing") })])
  })

  it("checks a Source that is not on GitHub as it is", async () => {
    const items = [
      { key: "hello.md", path: "hello.md", content: page("Hello from Acme", "See [world](/blog/wrld).\n") },
      { key: "world.md", path: "world.md", content: page("World from Acme") },
    ]
    const content = defineContent({ sources: { blog: contentSource({ items: async () => items }, { url: "/blog/:id" }) }, logger: false })
    cleanup.push(() => content.dispose())
    const result = await content.check()
    expect(result).toMatchObject({ ok: false, errors: 1, sources: [{ source: "blog", sha: null, pages: 2 }] })
    expect(result.findings).toEqual([expect.objectContaining({ path: "hello.md", url: "/blog/hello", line: 5, rule: "link" })])
    await expect(content.check({ sha: "0".repeat(40) })).rejects.toMatchObject({ code: "CONTENT_R0069" })
  })

  it("throws CONTENT_R0069 for a SHA that is not a full commit SHA", async () => {
    fake.commit("main", { "guide.md": page("Getting started") })
    const content = server()
    await expect(content.check({ sha: "main" })).rejects.toMatchObject({ code: "CONTENT_R0069" })
    await expect(content.check({ source: "blog" })).rejects.toMatchObject({ code: "CONTENT_R0069" })
  })

  it("runs through vitehub content check against the running app", async () => {
    const sha = fake.commit("main", { "guide/index.md": page("Getting started", "Read [the setup](/guide/setup).\n") })
    const content = server()
    const registry = createOperationRegistry([{ operations: contentOperations }])
    Reflect.set(globalThis, Symbol.for("vitehub.console.section-modules"), { content: async () => ({ default: content }) })
    cleanup.push(() => { Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.section-modules")) })
    const app = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { input, operation } = operationRpcRequest(init?.body)
      const result = await runOperation(registry, operation, input, { access: { mode: "local", sections: "all" }, development: true, surface: "cli", user: null })
      return operationRpcResponse(init?.body, result)
    })

    const shown = await cli("/app", ["--sha", sha], app)
    expect(shown.code).toBe(1)
    expect(shown.stdout).toContain("guide/index.md:5  error  CONTENT_R0062  /guide links to /guide/setup")
    expect(shown.stderr).toBe(`1 page in docs at ${sha}: 1 error, 0 warnings.\n`)
  })
})

describe("vitehub content check --dir", () => {
  async function folder(files: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "vitehub-content-check-dir-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), text)
    }
    return root
  }

  it("exits 1 on errors and prints JSON with --json", async () => {
    const root = await folder({
      "content/index.md": page("Welcome to Acme", "See [the guide](/guide) and [setup](/guide/setup#install).\n"),
      "content/guide/index.md": page("Guide to Acme", "## Install\n"),
      "content/broken.md": "---\ntitle: [unclosed\n---\nBody\n",
    })

    const text = await cli(root, ["--dir", "content"])
    expect(text.code).toBe(1)
    expect(text.stdout).toContain("broken.md  error  CONTENT_R0060  broken.md does not parse: unexpected end of the stream within a flow collection (1:17). Fix the file so it loads.\n")
    expect(text.stdout).toContain("index.md:5  error  CONTENT_R0062  / links to /guide/setup, which is no page of Source \"default\".")
    expect(text.stderr).toBe("2 pages in default: 2 errors, 0 warnings.\n")

    const json = await cli(root, ["--dir", "content", "--json"])
    expect(json.code).toBe(1)
    const result = JSON.parse(json.stdout) as ContentCheckResult
    expect(result).toMatchObject({ ok: false, errors: 2, warnings: 0, sources: [{ source: "default", sha: null, pages: 2 }] })
    expect(result.findings.map(finding => [finding.path, finding.rule])).toEqual([["broken.md", "parse"], ["index.md", "link"]])
  })

  it("exits 0 with warnings, and applies --page-url, --ignore, --schema, and --title-template", async () => {
    const root = await folder({
      "posts/hello.md": "---\ntitle: Hello\n---\n# Hello\n\n### Deep\n\nSee [the API](/blog/api/feed) and [world](/blog/world#intro).\n",
      "posts/world.md": "---\ntitle: Hello\n---\n## Intro\n",
      "schema.json": JSON.stringify({ type: "object", properties: { title: { type: "string" } }, required: ["title"] }),
    })

    const warned = await cli(root, ["docs", "--dir", "posts", "--page-url", "/blog/:id", "--ignore", "/blog/api/**", "--schema", "schema.json", "--title-template", "%s · Acme Blog", "--json"])
    expect(warned.code).toBe(0)
    const result = JSON.parse(warned.stdout) as ContentCheckResult
    expect(result).toMatchObject({ ok: true, errors: 0, sources: [{ source: "docs", pages: 2 }] })
    expect(result.findings.map(finding => [finding.url, finding.rule])).toEqual([
      ["/blog/hello", "heading-order"],
      ["/blog/hello", "description"],
      ["/blog/hello", "duplicate"],
      ["/blog/world", "description"],
      ["/blog/world", "duplicate"],
    ])

    const failed = await cli(root, ["--dir", "posts", "--page-url", "/blog/:id"])
    expect(failed.code).toBe(1)
    expect(failed.stdout).toContain("hello.md:8  error  CONTENT_R0062  /blog/hello links to /blog/api/feed")
  })

  it("rejects local options without --dir, and a folder that does not exist", async () => {
    const root = await folder({})
    expect(await cli(root, ["--schema", "schema.json"])).toMatchObject({ code: 1, stderr: expect.stringContaining("need --dir") })
    expect(await cli(root, ["--dir", "missing", "--json"])).toMatchObject({ code: 1, stdout: expect.stringContaining("CONTENT_R0069") })
  })
})
