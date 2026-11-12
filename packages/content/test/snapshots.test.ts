import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSource, files } from "@vite-hub/source"
import type { ContentFile, ContentPlugin } from "comark-content"

import { buildContentSnapshots, defineContent, registerContentSnapshots } from "../src/index.ts"
import type { BuiltContentSnapshot, ContentSnapshot } from "../src/index.ts"
import { withContentSnapshot } from "../src/snapshots.ts"
import { buildContentSnapshotModules, hubContent } from "../src/vite.ts"

const docs = {
  "guide/index.md": "---\ntitle: Guide\n---\n# Guide\n\nStart here.\n",
  "guide/install.md": "---\ntitle: Install\n---\n# Install\n\nRun the installer.\n",
}

/** Counts Markdown parses, and keeps what `file:bulk:load` received. */
function recorder() {
  const record = { parsed: 0, bulk: [] as ContentFile[][] }
  const plugin: ContentPlugin = {
    name: "recorder",
    setup(content) {
      content.hooks.hook("file:parsed", () => {
        record.parsed++
      })
      content.hooks.hook("file:bulk:load", (_source, items) => {
        record.bulk.push(items)
      })
    },
  }
  return { record, plugin }
}

async function snapshotOf(entries: Record<string, string>) {
  const { snapshots } = await buildContentSnapshots(defineContent({ sources: { docs: files(entries) } }))
  return snapshots.docs!
}

const gzip = (text: string) => gzipSync(text).toString("base64")

/** The snapshot as the bundle serves it, counting the shards that load. */
function served(built: BuiltContentSnapshot, loaded: number[] = []): () => Promise<ContentSnapshot> {
  return async () => ({ index: gzip(built.index), shards: built.shards.map((shard, number) => async () => (loaded.push(number), gzip(shard))) })
}

afterEach(() => {
  // A test that registers snapshots and then fails must not leak them into the next defineContent() call.
  registerContentSnapshots({})
})

describe("Content snapshots", () => {
  it("serves a files() Source from its build-time snapshot without parsing Markdown", async () => {
    const live = defineContent({ sources: { docs: files(docs) } })
    const snapshot = await snapshotOf(docs)
    const { record, plugin } = recorder()
    registerContentSnapshots({ docs: served(snapshot) })
    const content = defineContent({ plugins: [plugin], sources: { docs: files(docs) } })

    expect(await content.get("/guide/install")).toEqual(await live.get("/guide/install"))
    expect(await content.navigation()).toEqual(await live.navigation())
    expect((await content.list("docs")).map(item => [item.path, item.data])).toEqual((await live.list("docs")).map(item => [item.path, item.data]))
    expect(record.parsed).toBe(0)
    // Reads that need no bodies load only the index. A full load gives index plugins every document, bodies included.
    expect(record.bulk).toEqual([])
    expect((await content.handler(new Request("http://localhost/api/content/snapshot/docs.json"))).status).toBe(200)
    expect(record.parsed).toBe(0)
    expect(record.bulk).toHaveLength(1)
    expect(record.bulk[0]!.map(item => [item.path, item.nodes.length > 0])).toEqual([["/guide", true], ["/guide/install", true]])
  })

  it("lists from the index and reads one shard for get()", async () => {
    // Bodies of about 400 KB put each document in its own shard.
    const large = Object.fromEntries(["a", "b", "c"].map(name => [`${name}.md`, `---\ntitle: ${name}\n---\n# ${name}\n\n${"word ".repeat(80_000)}\n`]))
    const snapshot = await snapshotOf(large)
    expect(snapshot.shards).toHaveLength(3)
    const loaded: number[] = []
    registerContentSnapshots({ docs: served(snapshot, loaded) })
    const content = defineContent({ sources: { docs: files(large) } })

    expect((await content.list("docs")).map(item => item.data.title)).toEqual(["a", "b", "c"])
    expect(await content.navigation()).toHaveLength(3)
    expect(loaded).toEqual([])
    // Hosts without node:zlib, such as Workers without nodejs_compat, inflate with DecompressionStream.
    const getBuiltinModule = vi.spyOn(process, "getBuiltinModule").mockReturnValue(undefined)
    expect((await content.get("/b"))?.data.title).toBe("b")
    expect(getBuiltinModule).toHaveBeenCalledWith("node:zlib")
    vi.restoreAllMocks()
    expect(loaded).toEqual([1])
    await content.handler(new Request("http://localhost/api/content/snapshot/docs.json"))
    expect(loaded.sort()).toEqual([0, 1, 2])
  })

  it("loads the snapshot and a shard again after a failed load", async () => {
    const snapshot = await snapshotOf(docs)
    const serve = served(snapshot)
    let failShard = true
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("transient snapshot failure"))
      .mockImplementation(async () => {
        const loaded = await serve()
        return {
          ...loaded,
          shards: loaded.shards.map(shard => async () => {
            if (!failShard) return await shard()
            failShard = false
            throw new Error("transient shard failure")
          }),
        }
      })
    // SAFETY: The snapshot reads only its loader and the Source keys; it keeps the origin for refresh() alone.
    const parsed = withContentSnapshot({} as never, load, async () => Object.keys(docs))

    await expect(parsed.manifest!()).rejects.toThrow("transient snapshot failure")
    await expect(parsed.manifest!()).resolves.toBeDefined()
    await expect(parsed.get!("guide/install.md")).rejects.toThrow("transient shard failure")
    await expect(parsed.get!("guide/install.md")).resolves.toMatchObject({ path: "/guide/install" })
  })

  it("reads no file of the Source until refresh()", async () => {
    const snapshot = await snapshotOf(docs)
    const reads: string[] = []
    const lazy = Object.fromEntries(Object.entries(docs).map(([key, text]) => [key, async () => (reads.push(key), text)]))
    registerContentSnapshots({ docs: served(snapshot) })
    const content = defineContent({ sources: { docs: files(lazy) } })

    expect((await content.list("docs")).map(item => item.path)).toEqual(["/guide", "/guide/install"])
    expect((await content.get("/guide/install"))?.data.title).toBe("Install")
    await content.handler(new Request("http://localhost/api/content/snapshot/docs.json"))
    expect(reads).toEqual([])
    await content.cache.refresh("docs")
    expect(reads.sort()).toEqual(Object.keys(docs))
  })

  it("keeps the Source as the authority for refresh()", async () => {
    const snapshot = await snapshotOf(docs)
    const { record, plugin } = recorder()
    registerContentSnapshots({ docs: served(snapshot) })
    const content = defineContent({ plugins: [plugin], sources: { docs: files(docs) } })

    await content.list("docs")
    expect(record.parsed).toBe(0)
    await content.cache.refresh("docs")
    expect(record.parsed).toBe(2)
  })

  it("parses the Source when the snapshot holds other keys", async () => {
    const snapshot = await snapshotOf({ "guide/index.md": docs["guide/index.md"] })
    const { record, plugin } = recorder()
    registerContentSnapshots({ docs: served(snapshot) })
    const content = defineContent({ plugins: [plugin], sources: { docs: files(docs) } })

    expect((await content.list("docs")).map(item => item.path)).toEqual(["/guide", "/guide/install"])
    expect(record.parsed).toBeGreaterThan(0)
  })

  it("ignores snapshots for Sources that are not files()", async () => {
    const snapshot = await snapshotOf(docs)
    const { record, plugin } = recorder()
    const remote = defineSource({
      name: "remote",
      getKeys: async () => Object.keys(docs),
      getItem: async (key: string) => ({ key, path: key, content: docs[key as keyof typeof docs] }),
    })
    registerContentSnapshots({ docs: served(snapshot) })
    const content = defineContent({ plugins: [plugin], sources: { docs: remote } })

    await content.list("docs")
    expect(record.parsed).toBeGreaterThan(0)
  })

  it("gives registered snapshots to the next defineContent() call only", async () => {
    const snapshot = await snapshotOf(docs)
    registerContentSnapshots({ docs: served(snapshot) })
    defineContent({ sources: { docs: files(docs) } })
    const { record, plugin } = recorder()
    const later = defineContent({ plugins: [plugin], sources: { docs: files(docs) } })

    await later.list("docs")
    expect(record.parsed).toBeGreaterThan(0)
  })

  it("does not run index plugins while the build parses", async () => {
    const { record, plugin } = recorder()
    const content = defineContent({ plugins: [plugin], sources: { docs: files(docs) } })

    const { snapshots, skipped } = await buildContentSnapshots(content)
    expect(Object.keys(snapshots)).toEqual(["docs"])
    expect(skipped).toEqual({})
    expect(record.parsed).toBe(2)
    expect(record.bulk).toEqual([])
    // The hook dispatch is restored after the build.
    await content.cache.refresh("docs")
    expect(record.bulk).toHaveLength(1)
  })

  it("snapshots only read-only glob() and files() Sources", async () => {
    const remote = defineSource({
      name: "remote",
      getKeys: async () => Object.keys(docs),
      getItem: async (key: string) => ({ key, path: key, content: docs[key as keyof typeof docs] }),
    })
    const content = defineContent({ sources: { docs: files(docs), remote } })

    expect(Object.keys((await buildContentSnapshots(content)).snapshots)).toEqual(["docs"])
  })
})

describe("Content snapshot build", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function fixture(contentModule: string) {
    // Inside the package, so the fixture resolves `@vite-hub/source` and `comark-content` as an app would.
    await mkdir(join(import.meta.dirname, ".vitest-tmp"), { recursive: true })
    root = await mkdtemp(join(import.meta.dirname, ".vitest-tmp/snapshot-app-"))
    await mkdir(join(root, "server"), { recursive: true })
    await writeFile(join(root, "package.json"), "{ \"type\": \"module\" }\n")
    await writeFile(join(root, "server/content.ts"), contentModule)
    await writeFile(join(root, "server/entry.ts"), "export { default } from \"./content.ts\"\n")
    return root
  }

  const importBase = join(import.meta.dirname, "../src/index.ts")
  const contentModule = [
    `import { defineContent } from ${JSON.stringify(importBase)}`,
    "import { files } from \"@vite-hub/source\"",
    "",
    `export default defineContent({ sources: { docs: files(${JSON.stringify(docs)}) } })`,
    "",
  ].join("\n")

  it("reports a Content module that cannot load in Node and ships no snapshot", async () => {
    const project = await fixture(`import "missing-module"\n${contentModule}`)
    const result = await buildContentSnapshotModules({ file: join(project, "server/content.ts"), projectRoot: project, importBase })
    expect(result.snapshots).toEqual({})
    expect(result.warnings).toEqual([expect.stringContaining("The build could not load server/content.ts")])
  })

  it("ships the parsed Sources in a server build and loads them on the first read", async () => {
    const project = await fixture(contentModule)
    const { build } = await import("vite")
    await build({
      configFile: false,
      logLevel: "silent",
      root: project,
      plugins: [hubContent({ importBase })],
      build: { ssr: "server/entry.ts", outDir: "dist", rollupOptions: { output: { entryFileNames: "entry.mjs" } } },
    })

    const output = await readdir(join(project, "dist"), { recursive: true })
    expect(output).toContain("entry.mjs")
    expect(output.filter(file => file.includes("vitehub-content-snapshot_"))).toEqual([expect.stringMatching(/vitehub-content-snapshot_docs-/), expect.stringMatching(/vitehub-content-snapshot_docs_0-/)])

    const { default: content } = await import(pathToFileURL(join(project, "dist/entry.mjs")).href)
    const live = defineContent({ sources: { docs: files(docs) } })
    // A live Source lists from a frontmatter-only parse. The snapshot holds full parses, so its entries are not partial.
    expect((await live.list("docs")).map(item => item.meta.partial)).toEqual([true, true])
    expect((await content.list("docs")).map((item: ContentFile) => item.meta.partial)).toEqual([false, false])
    expect(await content.get("/guide/install")).toEqual(await live.get("/guide/install"))
    expect(await content.navigation()).toEqual(await live.navigation())
  })
})
