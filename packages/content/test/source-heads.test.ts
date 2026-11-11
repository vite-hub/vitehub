import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { CommitMemory, parserHash } from "../src/commit-cache.ts"
import { defineContent, registerContentKV } from "../src/index.ts"
import { hubContent } from "../src/vite.ts"

import type { ContentOptions } from "comark-content"
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
function server(options: { markdown?: ContentOptions["markdown"] } = {}) {
  const content = defineContent({ sources: { docs: github({ repo: "acme/docs", ref: "main" }) }, logger: false, ...options })
  cleanup.push(() => content.dispose())
  return content
}

async function title(content: ReturnType<typeof server>, path: string) {
  return (await content.get(path))?.data.title
}

/** The GitHub archives that the fake served. */
function downloads() {
  return fake.requests.filter(request => /\/tarball\/|\/tar\.gz\//.test(request.path)).length
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

  it("names the Sources that have a head", async () => {
    const content = server()
    await expect(content.sources.head()).rejects.toMatchObject({ code: "CONTENT_R0008", message: expect.stringContaining("Sources with a head: docs") })
  })
})

describe("commit cache", () => {
  it("downloads each commit once, and a server with a warm KV downloads nothing", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide"), "intro.md": page("Intro") })
    const content = server()

    // Validation and serving share the download.
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await title(content, "/intro")).toBe("Intro")
    expect(downloads()).toBe(1)
    const head = await content.sources.head("docs")
    expect(head.cache).toEqual({ key: expect.stringMatching(new RegExp(`^content:[0-9a-f]{16}:${first}:docs$`)), hits: { memory: expect.any(Number), kv: 0 }, misses: 1 })
    const [, stored] = await kv.get(head.cache.key!)
    expect(stored).toMatchObject({ name: "docs", data: expect.any(String) })

    const other = server()
    expect(await title(other, "/guide")).toBe("Guide")
    expect((await other.list()).length).toBe(2)
    expect(downloads()).toBe(1)
    expect((await other.sources.head("docs")).cache).toMatchObject({ key: head.cache.key, hits: { kv: 1 }, misses: 0 })

    // A new head is a new key: one more download, shared by advance() and the reload.
    fake.commit("main", { "guide.md": page("Guide v2") })
    await content.sources.advance("docs")
    expect(await title(content, "/guide")).toBe("Guide v2")
    expect(downloads()).toBe(2)
  })

  it("keeps documents that a server changes out of the cached commit", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    await content.sources.advance("docs")
    expect(await title(content, "/new")).toBe("New")

    // A rollback reads the first commit from memory: no download, and no document of the second commit.
    await content.sources.pin(first, "docs")
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await title(content, "/new")).toBeUndefined()
    expect((await content.list()).map(item => item.path)).toEqual(["/guide"])
    expect(downloads()).toBe(2)
  })

  it("stores no rejected commit", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const bad = fake.commit("main", { "broken.md": broken })
    await content.sources.advance("docs")
    const key = (await content.sources.head("docs")).cache.key!.replace(/:[0-9a-f]{40}:/, `:${bad}:`)
    const [, stored] = await kv.get(key)
    expect(stored).toBeNull()
    expect(downloads()).toBe(2)
  })

  it("uses another key when the parser config changes", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const { key } = (await content.sources.head("docs")).cache

    const other = server({ markdown: { autoClose: false } })
    expect(await title(other, "/guide")).toBe("Guide")
    const changed = (await other.sources.head("docs")).cache
    expect(changed.key).not.toBe(key)
    expect(changed.key?.split(":")[2]).toBe(key?.split(":")[2])
    expect(changed).toMatchObject({ hits: { kv: 0 }, misses: 1 })
    expect(downloads()).toBe(2)

    // A plugin counts by its source text, so a changed plugin gives another hash.
    const plugin = (version: number) => ({ name: "plugin", setup: version === 1 ? () => "one" : () => "two" })
    expect(await parserHash({ plugins: [plugin(1)] })).not.toBe(await parserHash({ plugins: [plugin(2)] }))
    expect(await parserHash({ plugins: [plugin(1)] })).toBe(await parserHash({ plugins: [plugin(1)] }))
  })

  it("holds a bounded number of commits in memory", async () => {
    const shas = [fake.commit("main", { "guide.md": page("Guide 0") })]
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide 0")
    for (let index = 1; index < 6; index++) {
      shas.push(fake.commit("main", { "guide.md": page(`Guide ${index}`) }))
      await content.sources.advance("docs")
    }
    expect(downloads()).toBe(6)

    // The first commit left memory, so the rollback reads it from KV, not from GitHub.
    const before = (await content.sources.head("docs")).cache.hits.kv
    await content.sources.pin(shas[0]!, "docs")
    expect(await title(content, "/guide")).toBe("Guide 0")
    expect((await content.sources.head("docs")).cache.hits.kv).toBe(before + 1)
    expect(downloads()).toBe(6)

    const memory = new CommitMemory<number>(2)
    for (let index = 0; index < 10; index++) memory.set(String(index), index)
    expect(memory.size).toBe(2)
    expect(memory.get("8")).toBe(8)
    memory.set("10", 10)
    expect(memory.get("9")).toBeUndefined()
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
