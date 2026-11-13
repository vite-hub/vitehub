import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { buildContentSnapshots, contentSource, defineContent, registerContentKV, registerContentSnapshots } from "../src/index.ts"
import { hubContent } from "../src/vite.ts"

import type { BuiltContentSnapshot, ContentSnapshot } from "../src/index.ts"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub

const page = (title: string) => `---\ntitle: ${title}\n---\nBody\n`

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-github-snapshot-"))
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
})

afterEach(async () => {
  registerContentSnapshots({})
  registerContentKV(undefined)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function server() {
  const content = defineContent({ route: "public", sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }) }, logger: false })
  cleanup.push(() => content.dispose())
  return content
}

/** The GitHub archives that the fake served. */
function downloads() {
  return fake.requests.filter(request => /\/tarball\/|\/tar\.gz\//.test(request.path)).length
}

/** Parse the Sources as the build does. The build loads `server/content.ts` without KV. */
async function build() {
  return await buildContentSnapshots(server())
}

const gzip = (text: string) => gzipSync(text).toString("base64")

/** The snapshot as the bundle serves it, counting the shard loads. */
function served(built: BuiltContentSnapshot, loaded: number[] = []): () => Promise<ContentSnapshot> {
  return async () => ({ index: gzip(built.index), shards: built.shards.map((shard, number) => async () => (loaded.push(number), gzip(shard))) })
}

describe("build snapshots of github() Sources", () => {
  it("serves the build commit on a cold server with no archive download", async () => {
    const sha = fake.commit("main", { "guide.md": page("Guide"), "intro.md": page("Intro") })
    const { snapshots, skipped } = await build()
    expect(skipped).toEqual({})
    expect(JSON.parse(snapshots.docs!.index)).toEqual({ commit: { sha, ref: "main", origin: expect.any(String) } })
    const atBuild = downloads()
    expect(atBuild).toBe(1)

    const loaded: number[] = []
    registerContentSnapshots({ docs: served(snapshots.docs!, loaded) })
    // The server: KV is empty, so the first read resolves and validates the head.
    registerContentKV(kv)
    const content = server()
    expect((await content.get("/guide"))?.data.title).toBe("Guide")
    expect((await content.list()).length).toBe(2)
    expect(downloads()).toBe(atBuild)
    expect(loaded).toEqual([0])
    expect(await content.sources.head("docs")).toMatchObject({ sha, cache: { hits: { build: 1, kv: 0 }, misses: 0 } })
  })

  it("downloads once when the head moved after the build, and never loads the snapshot commit", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const { snapshots } = await build()
    const next = fake.commit("main", { "guide.md": page("Guide v2") })

    const loaded: number[] = []
    registerContentSnapshots({ docs: served(snapshots.docs!, loaded) })
    registerContentKV(kv)
    const content = server()
    const before = downloads()
    expect((await content.get("/guide"))?.data.title).toBe("Guide v2")
    expect(downloads()).toBe(before + 1)
    expect(loaded).toEqual([])
    expect(await content.sources.head("docs")).toMatchObject({ sha: next, cache: { hits: { build: 0 }, misses: 1 } })
  })

  it("serves the build commit again when the head moves back to it", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const { snapshots } = await build()
    fake.commit("main", { "guide.md": page("Guide v2") })
    registerContentSnapshots({ docs: served(snapshots.docs!) })
    registerContentKV(kv)
    const content = server()
    expect((await content.get("/guide"))?.data.title).toBe("Guide v2")
    const before = downloads()
    await content.sources.pin(first, "docs")
    expect((await content.get("/guide"))?.data.title).toBe("Guide")
    expect(downloads()).toBe(before)
  })

  it("makes no snapshot and no warning without a token at build", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    expect(await build()).toEqual({ snapshots: {}, skipped: {} })
    expect(fake.requests).toEqual([])

    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
    registerContentKV(kv)
    const content = server()
    expect((await content.get("/guide"))?.data.title).toBe("Guide")
    expect(downloads()).toBe(1)
    expect((await content.sources.head("docs")).cache).toMatchObject({ hits: { build: 0 }, misses: 1 })
  })

  it("ignores a snapshot of another repository", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const { snapshots } = await build()
    const index = JSON.parse(snapshots.docs!.index)
    index.commit.origin = JSON.stringify({ repo: "acme/other" })
    registerContentSnapshots({ docs: served({ ...snapshots.docs!, index: JSON.stringify(index) }) })
    registerContentKV(kv)
    const content = server()
    const before = downloads()
    expect((await content.get("/guide"))?.data.title).toBe("Guide")
    expect(downloads()).toBe(before + 1)
  })

  it("reports a build commit that does not parse and ships no snapshot", async () => {
    fake.commit("main", { "broken.md": "---\ntitle: [unclosed\n---\n" })
    const { snapshots, skipped } = await build()
    expect(snapshots).toEqual({})
    expect(skipped.docs).toMatch(/failed validation: broken\.md/)
  })
})

describe("github() snapshot in a server build", () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it("ships the build commit as a lazy module and serves it with no download", async () => {
    const sha = fake.commit("main", { "guide.md": page("Guide") })
    // Inside the package, so the fixture resolves `@vite-hub/source` and `@vite-hub/kv` as an app would.
    await mkdir(join(import.meta.dirname, ".vitest-tmp"), { recursive: true })
    root = await mkdtemp(join(import.meta.dirname, ".vitest-tmp/github-snapshot-app-"))
    await mkdir(join(root, "server"), { recursive: true })
    const importBase = join(import.meta.dirname, "../src/index.ts")
    await writeFile(join(root, "package.json"), "{ \"type\": \"module\" }\n")
    await writeFile(join(root, "server/entry.ts"), "export { default } from \"./content.ts\"\n")
    await writeFile(join(root, "server/content.ts"), [
      `import { contentSource, defineContent, registerContentKV } from ${JSON.stringify(importBase)}`,
      "import { github } from \"@vite-hub/source\"",
      "import { kv } from \"@vite-hub/kv\"",
      "",
      "registerContentKV(kv)",
      "export default defineContent({ route: 'public', sources: { docs: contentSource(github({ repo: \"acme/docs\", ref: \"main\" }), { url: \"/:id\" }) }, logger: false })",
      "",
    ].join("\n"))
    const { build: viteBuild } = await import("vite")
    await viteBuild({
      configFile: false,
      logLevel: "silent",
      root,
      plugins: [hubContent({ importBase })],
      // The app imports KV from the host. The test serves it from the test mode store.
      build: { ssr: "server/entry.ts", outDir: "dist", rollupOptions: { external: ["@vite-hub/kv"], output: { entryFileNames: "entry.mjs" } } },
    })
    const output = await readdir(join(root, "dist"), { recursive: true })
    expect(output.filter(file => file.includes("vitehub-content-snapshot_"))).toEqual([expect.stringMatching(/vitehub-content-snapshot_docs-/), expect.stringMatching(/vitehub-content-snapshot_docs_0-/)])
    const atBuild = downloads()
    expect(atBuild).toBe(1)

    const { default: content } = await import(pathToFileURL(join(root, "dist/entry.mjs")).href)
    cleanup.push(() => content.dispose())
    expect((await content.get("/guide"))?.data.title).toBe("Guide")
    expect(downloads()).toBe(atBuild)
    expect(await content.sources.head("docs")).toMatchObject({ sha, cache: { hits: { build: 1 }, misses: 0 } })
  })
})
