import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memory } from "comark-content"
import sqlite from "comark-content/database/sqlite-node"
import sqlQuery from "comark-content/plugins/sql-query"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { contentSource, defineContent, generateContentTypes, registerContentKV } from "../src/index.ts"
import { hubContent } from "../src/vite.ts"

import type { MockInstance } from "vitest"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
let warn: MockInstance<typeof console.warn>

const page = (title: string, body = "Body\n") => `---\ntitle: ${title}\n---\n${body}`
/** Frontmatter that YAML cannot parse. */
const broken = "---\ntitle: [unclosed\n---\nBody\n"

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-head-"))
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
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  // The build does this at the top of server/content.ts when the app enables KV.
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  warn.mockRestore()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** One Content runtime, as one server instance would create it. */
function server(options: Parameters<typeof defineContent>[0] = {}) {
  const content = defineContent({ sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }) }, logger: false, ...options })
  cleanup.push(() => content.dispose())
  return content
}

async function title(content: ReturnType<typeof server>, path: string) {
  return (await content.get(path))?.data.title
}

/** The warnings with a diagnostic code. */
function warned(code: string) {
  return warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes(code))
}

describe("content.sources", () => {
  it("resolves the head on the first read and stores it in KV", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    const head = await content.sources.head("docs")
    expect(head).toMatchObject({ source: "docs", live: true, sha: first, ref: "main", pinned: false, rejected: null })
    expect(Date.parse(head.movedAt!)).not.toBeNaN()
    const [, stored] = await kv.get<{ sha: string }>("content:head:docs")
    expect(stored).toMatchObject({ sha: first, ref: "main" })
  })

  it("serves the head commit until advance() moves it to a valid push", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")

    const second = fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    // A push alone does not change what readers get.
    expect(await title(content, "/guide")).toBe("Guide")

    expect(await content.sources.advance("docs")).toMatchObject({ sha: second, rejected: null })
    expect(await title(content, "/guide")).toBe("Guide v2")
    expect(await title(content, "/new")).toBe("New")
  })

  it("keeps the last valid head when a push has a document that does not parse", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")

    const bad = fake.commit("main", { "guide.md": page("Guide v2"), "broken.md": broken })
    const head = await content.sources.advance("docs")

    expect(head).toMatchObject({ sha: first, rejected: { sha: bad, reason: expect.stringMatching(/^broken\.md: unexpected end of the stream/) } })
    expect(await title(content, "/guide")).toBe("Guide")
    expect(warned("CONTENT_R0019")).toEqual([expect.stringContaining(`Commit ${bad} of Content source "docs" failed validation, so Content keeps commit ${first}`)])

    // A rejected commit is not checked again, and a fixed push moves the head past it.
    await content.sources.advance("docs")
    expect(warned("CONTENT_R0019")).toHaveLength(1)
    const fixed = fake.commit("main", { "broken.md": page("Fixed") })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: fixed, rejected: null })
    expect(await title(content, "/broken")).toBe("Fixed")
  })

  it("reads a head that another server moved after the in-memory hold expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const reader = server()
    const writer = server()
    expect(await title(reader, "/guide")).toBe("Guide")

    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    await writer.sources.advance("docs")
    vi.advanceTimersByTime(4_000)
    expect(await title(reader, "/guide")).toBe("Guide")

    vi.advanceTimersByTime(1_500)
    expect(await title(reader, "/guide")).toBe("Guide v2")
    expect((await reader.sources.head("docs")).sha).toBe(second)
  })

  it("pins a commit until unpin()", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    await content.sources.advance("docs")

    expect(await content.sources.pin(first, "docs")).toMatchObject({ sha: first, pinned: true })
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await content.sources.advance("docs")).toMatchObject({ sha: first, pinned: true })

    expect(await content.sources.unpin("docs")).toMatchObject({ sha: second, pinned: false })
    expect(await title(content, "/guide")).toBe("Guide v2")
    await expect(content.sources.pin("main", "docs")).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("reads the branch without a head when there is no token", async () => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    expect(await content.sources.head("docs")).toMatchObject({ live: false, sha: null })
    expect(warned("CONTENT_R0020")).toEqual([expect.stringContaining("VITEHUB_GITHUB_TOKEN")])
    const [, stored] = await kv.get("content:head:docs")
    expect(stored).toBeNull()
    await expect(content.sources.pin(fake.head("main")!, "docs")).rejects.toMatchObject({ code: "CONTENT_R0020" })
  })

  it("reads the branch without a head when the app has no KV store", async () => {
    registerContentKV(undefined)
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    expect(await content.sources.head("docs")).toMatchObject({ live: false, sha: null })
    expect(warned("CONTENT_R0021")).toEqual([expect.stringContaining("Remove `kv: false`")])
    await expect(content.sources.pin(fake.head("main")!, "docs")).rejects.toMatchObject({ code: "CONTENT_R0021" })
  })

  it("serves the branch and logs CONTENT_R0022 when KV fails on a read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const failing = { get: vi.fn(async () => { throw new Error("KV binding is missing") }), set: vi.fn(async () => [undefined, undefined] as const) }
    registerContentKV(failing)
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    expect(warned("CONTENT_R0022")).toEqual([expect.stringContaining(`The KV store failed on "content:head:docs" for Content source "docs": KV binding is missing`)])
    expect(await content.sources.head("docs").catch((error: unknown) => error)).toMatchObject({ code: "CONTENT_R0022" })
    // Reads wait 5 seconds before they call the failing store again.
    failing.get.mockClear()
    vi.advanceTimersByTime(5_500)
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await title(content, "/guide")).toBe("Guide")
    expect(failing.get).toHaveBeenCalledTimes(1)
    expect(failing.set).not.toHaveBeenCalled()
    // An explicit call reports the failure to the caller.
    await expect(content.sources.advance("docs")).rejects.toMatchObject({ code: "CONTENT_R0022" })
  })

  it("keeps the validated commit that it serves when KV starts to fail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")

    registerContentKV({ get: async () => [new Error("KV is down"), null] as const, set: async () => [new Error("KV is down"), null] as const })
    fake.commit("main", { "guide.md": page("Guide v2") })
    vi.advanceTimersByTime(5_500)
    expect(await title(content, "/guide")).toBe("Guide")
    expect(warned("CONTENT_R0022")).toEqual([expect.stringContaining("KV is down")])
    // Without the fallback to the served commit, the read would load the latest commit of the branch.
    expect(fake.head("main")).not.toBe(first)
  })

  it.each(["query", "sitemap", "init", "types", "source"])("establishes and updates the head for cold %s reads", async (method) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    await server().sources.pin(first, "docs")
    const second = fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    const content = server({ plugins: [sqlQuery({ database: sqlite() })] })
    async function read() {
      if (method === "query") return (await content.query("docs").all()).map(item => item.path)
      if (method === "source") return await content.getSource("docs")!.keys()
      if (method === "sitemap") return (await content.sitemap()).map(item => item.loc)
      if (method === "types") await generateContentTypes(content)
      else await content.init()
      return (await content.instances[0]!.list()).map(item => item.path)
    }
    expect(await read()).toHaveLength(1)
    expect(await content.instances[0]!.get("/guide")).toMatchObject({ data: { title: "Guide" } })
    await server().sources.unpin("docs")
    vi.advanceTimersByTime(5_500)
    expect(await read()).toHaveLength(2)
    expect(await content.sources.head("docs")).toMatchObject({ sha: second })
  })

  it("does not serve a rejected initial commit and can explicitly retry the same SHA", async () => {
    const sha = fake.commit("main", { "guide.md": page("Guide") })
    let failing = true
    const content = server({ markdown: { plugins: [{ name: "reject-body", post() { if (failing) throw new Error("Body is invalid") } }] } })
    await expect(content.list("docs")).rejects.toBeDefined()
    expect(await content.sources.head("docs")).toMatchObject({ live: true, sha: null, rejected: { sha, reason: expect.stringContaining("Body is invalid") } })
    failing = false
    await expect(content.list("docs")).rejects.toBeDefined()
    expect(await content.sources.advance("docs")).toMatchObject({ sha, rejected: null })
    expect(await title(content, "/guide")).toBe("Guide")
  })

  it("does not serve the branch when the initial commit cannot be resolved", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("/commits/main")) return new Response("rate limited", { status: 429 })
      return fake.fetch(input, init)
    }))
    const content = server()
    await expect(content.list("docs")).rejects.toBeDefined()
    expect(await content.sources.head("docs")).toMatchObject({ live: true, sha: null })
  })

  it("does not restore a parsed cache from another selected commit on a cold rollback", async () => {
    const driver = memory()
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server({ cache: { driver } })
    expect(await title(content, "/guide")).toBe("Guide")
    fake.commit("main", { "guide.md": page("Guide v2") })
    await content.sources.advance("docs")
    expect(await title(content, "/guide")).toBe("Guide v2")
    await server({ cache: { driver } }).sources.pin(first, "docs")
    const cold = server({ cache: { driver } })
    expect(await cold.sources.head("docs")).toMatchObject({ sha: first, pinned: true })
    expect(await title(cold, "/guide")).toBe("Guide")
  })

  it("rebuilds a shared SQL index before executing a cold query at a pinned head", async () => {
    const database = sqlite()
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server({ plugins: [sqlQuery({ database })] })
    expect(await content.query("docs").count()).toBe(1)
    fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    await content.sources.advance("docs")
    expect(await content.query("docs").count()).toBe(2)
    await server().sources.pin(first, "docs")
    const cold = server({ plugins: [sqlQuery({ database })] })
    const query = cold.query("docs").where("path", "=", "/guide")
    expect(await query.first()).toMatchObject({ data: { title: "Guide" } })
    expect(await cold.query("docs").count()).toBe(1)
  })

  it("retries a selected head when its serving refresh failed", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    let downloads = 0
    let failing = true
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes(`/tarball/${second}`) && ++downloads > 1 && failing) throw new TypeError("fetch failed")
      return fake.fetch(input, init)
    }))
    await expect(content.sources.advance("docs")).rejects.toThrow("fetch failed")
    failing = false
    expect(await content.sources.head("docs")).toMatchObject({ sha: second })
    expect(await title(content, "/guide")).toBe("Guide v2")
    expect(await content.sources.advance("docs")).toMatchObject({ sha: second })
  })

  it("retries a valid rejected SHA after a temporary retrieval failure and restart", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes(`/tarball/${second}`)) throw new TypeError("fetch failed")
      return fake.fetch(input, init)
    }))
    expect(await content.sources.advance("docs")).toMatchObject({ rejected: { sha: second } })
    vi.stubGlobal("fetch", vi.fn(fake.fetch))
    const restarted = server()
    expect(await restarted.sources.advance("docs")).toMatchObject({ sha: second, rejected: null })
    expect(await title(restarted, "/guide")).toBe("Guide v2")
  })

  it("names the Sources that have a head", async () => {
    const content = server()
    await expect(content.sources.head()).rejects.toMatchObject({ code: "CONTENT_R0008", message: expect.stringContaining("Sources with a head: docs") })
  })
})

describe("hubContent() and KV", () => {
  async function transform(plugins: string[], command: "build" | "serve" = "serve") {
    const root = await mkdtemp(join(tmpdir(), "vitehub-content-head-vite-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/content.ts"), "export default {}\n")
    const plugin = hubContent()
    // SAFETY: The plugin reads only these fields of the resolved config and of the transform context.
    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ root, plugins: plugins.map(name => ({ name })), resolve: { alias: [] } })
    const { handler } = plugin.transform as { handler: (this: unknown, code: string, id: string) => Promise<{ code: string } | undefined> }
    return await handler.call({ environment: { config: { consumer: "server", command } } }, "export default {}\n", join(root, "server/content.ts"))
  }

  it("gives server/content.ts the app's KV store when the app enables KV", async () => {
    const result = await transform(["@vite-hub/kv/vite"])
    expect(result?.code).toContain(`import { kv as __vitehubContentKV } from "@vite-hub/kv"`)
    expect(result?.code).toContain("__vitehubRegisterContentKV(__vitehubContentKV)")
  })

  it("imports no KV when the app does not enable it", async () => {
    expect(await transform([])).toBeUndefined()
  })
})
