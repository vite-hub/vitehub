import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createLocalWorkspaceStore } from "../src/storage/local.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
  }
})

const tempDirs: string[] = []

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
  tempDirs.push(root)
  return createLocalWorkspaceStore(root)
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("local workspace store", () => {
  it("supports file tree operations, snapshots, and diffs", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.mkdir("generated")

    expect(await store.readFile("docs/readme.md")).toMatchObject({ path: "docs/readme.md" })
    expect(await store.stat("docs/readme.md")).toMatchObject({ type: "file", path: "docs/readme.md" })
    expect(await store.glob("**/*.md")).toHaveLength(1)
    expect(await store.list("", { recursive: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
      expect.objectContaining({ path: "generated", type: "directory" }),
    ]))

    const snapshot = await store.snapshot({ name: "baseline" })
    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "changed" })
    await store.writeFile("generated/notes.md", { path: "generated/notes.md", content: "notes" })
    const diff = await store.diff({ from: snapshot })

    expect(diff.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "modified" }),
      expect.objectContaining({ path: "generated/notes.md", type: "added" }),
    ]))

    await store.rm("generated", { recursive: true })
    expect(await store.stat("generated")).toBeUndefined()
  })

  it("lists only top-level entries when recursive is false", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.writeFile("guide/setup.md", { path: "guide/setup.md", content: "setup" })

    await expect(store.list("", { recursive: false })).resolves.toEqual([
      expect.objectContaining({ path: "docs", type: "directory" }),
      expect.objectContaining({ path: "guide", type: "directory" }),
    ])
  })

  it("hashes local file entries without reading whole files into memory", async () => {
    const store = await createStore()
    const content = new Uint8Array([0, 1, 2, 3, 254, 255])
    const digest = createHash("sha256").update(content).digest("hex")

    await store.writeFile("assets/blob.bin", { path: "assets/blob.bin", content })
    vi.mocked(readFile).mockClear()

    await expect(store.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ digest, path: "assets/blob.bin", type: "file" }),
    ]))
    await expect(store.stat("assets/blob.bin")).resolves.toMatchObject({ digest })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("does not rewrite local files when the content digest is unchanged", async () => {
    const store = await createStore()
    const content = new Uint8Array([0, 1, 2, 3])

    await store.writeFile("assets/blob.bin", { path: "assets/blob.bin", content })
    vi.mocked(writeFile).mockClear()

    await store.writeFile("assets/blob.bin", {
      path: "assets/blob.bin",
      content,
      mediaType: "application/octet-stream",
      metadata: { source: "airtable" },
    })

    expect(writeFile).not.toHaveBeenCalled()
    await expect(store.readFile("assets/blob.bin")).resolves.toMatchObject({
      mediaType: "application/octet-stream",
      metadata: { source: "airtable" },
    })
  })

  it("rejects a conditional write from a stale local store", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    await first.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    const baseline = await first.stat("docs/page.md")
    await second.writeFile("docs/page.md", { path: "docs/page.md", content: "second" })

    await expect(first.writeFileConditional?.("docs/page.md", { path: "docs/page.md", content: "stale" }, baseline?.digest || null))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    await expect(readFile(join(root, "docs/page.md"), "utf8")).resolves.toBe("second")
  })

  it("replaces metadata atomically through a temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)
    const metadata = { status: "updating", files: 1 }
    const metaPath = `${root}.meta.json`

    vi.mocked(writeFile).mockClear()
    await store.setMeta?.("source:airtable:snapshot", metadata)

    const writePath = String(vi.mocked(writeFile).mock.calls[0]?.[0])
    expect(writePath).not.toBe(metaPath)
    expect(writePath).toMatch(/\.meta\.json\.[^.]+\.tmp$/)
    await expect(readFile(metaPath, "utf8")).resolves.toContain("source:airtable:snapshot")
    await expect(store.getMeta?.("source:airtable:snapshot")).resolves.toEqual(metadata)
  })

  it("writes streamed files without buffering through fs.writeFile", async () => {
    const store = await createStore()
    const content = new Uint8Array([0, 1, 2, 3, 254, 255])
    const digest = createHash("sha256").update(content).digest("hex")

    await expect(store.writeFileStream?.("assets/blob.bin", {
      path: "assets/blob.bin",
      content: new ReadableStream({
        start(controller) {
          controller.enqueue(content.slice(0, 3))
          controller.enqueue(content.slice(3))
          controller.close()
        },
      }),
      mediaType: "application/octet-stream",
      metadata: { source: "stream" },
    })).resolves.toMatchObject({ digest, path: "assets/blob.bin", size: content.byteLength })

    expect(writeFile).not.toHaveBeenCalled()
    await expect(store.readFile("assets/blob.bin")).resolves.toMatchObject({
      content,
      mediaType: "application/octet-stream",
      metadata: { source: "stream" },
    })
  })

  it("supports brace, character class, and extglob patterns", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await store.writeFile("docs/guide.mdx", { path: "docs/guide.mdx", content: "guide" })
    await store.writeFile("docs/notes.txt", { path: "docs/notes.txt", content: "notes" })

    await expect(store.glob("docs/*.{md,mdx}")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
      expect.objectContaining({ path: "docs/guide.mdx", type: "file" }),
    ]))
    await expect(store.glob("docs/readme.m[d]")).resolves.toEqual([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
    ])
    await expect(store.glob("docs/!(*.txt)")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
      expect.objectContaining({ path: "docs/guide.mdx", type: "file" }),
    ]))
  })
})
