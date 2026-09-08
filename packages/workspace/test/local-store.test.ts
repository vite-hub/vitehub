import { createHash } from "node:crypto"
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createLocalWorkspaceStore } from "../src/storage/local.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    writeFile: vi.fn(actual.writeFile),
  }
})

const tempDirs: string[] = []

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
  tempDirs.push(root)
  return createLocalWorkspaceStore(root)
}

function metadataRoot(root: string) {
  return `${root}.vitehub-file-metadata-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).flatMap(path => [
    path,
    `${path}.vitehub-lock`,
    `${path}.vitehub-locks`,
    `${path}.vitehub-file-metadata`,
    metadataRoot(path),
    `${path}.meta.json`,
  ]).map(path => rm(path, { recursive: true, force: true })))
})

describe("local workspace store", () => {
  it("reuses cached sidecars across listings larger than the cache", async () => {
    const store = await createStore()
    const root = tempDirs.at(-1)!
    const paths = Array.from({ length: 1025 }, (_, index) => `file-${String(index).padStart(4, "0")}`)
    await Promise.all(paths.map(async (path) => {
      await writeFile(join(root, path), "content")
      const directory = `${metadataRoot(root)}/${path}`
      await mkdir(directory, { recursive: true })
      await writeFile(`${directory}/metadata.json`, JSON.stringify({ path, mediaType: "text/plain" }))
    }))
    const handle = await open(`${metadataRoot(root)}/${paths[0]}/metadata.json`, "r")
    const read = vi.spyOn(Object.getPrototypeOf(handle), "readFile")
    await handle.close()
    try {
      expect(await store.list()).toHaveLength(1025)
      expect(read).toHaveBeenCalledTimes(1025)
      read.mockClear()
      expect(await store.list()).toHaveLength(1025)
      expect(read).toHaveBeenCalledTimes(1)
      read.mockClear()
      expect(await store.list()).toHaveLength(1025)
      expect(read).toHaveBeenCalledTimes(1)
    }
    finally {
      read.mockRestore()
    }
  })

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

  it("hashes local files only for stats and snapshots", async () => {
    const store = await createStore()
    const content = new Uint8Array([0, 1, 2, 3, 254, 255])
    const digest = createHash("sha256").update(content).digest("hex")

    await store.writeFile("assets/blob.bin", { path: "assets/blob.bin", content })
    vi.mocked(readFile).mockClear()

    const entries = await store.list("", { recursive: true })
    expect(entries.find(entry => entry.path === "assets/blob.bin")).not.toHaveProperty("digest")
    await expect(store.stat("assets/blob.bin")).resolves.toMatchObject({ digest })
    await expect(store.snapshot()).resolves.toMatchObject({
      entries: { "assets/blob.bin": expect.objectContaining({ digest }) },
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("does not traverse excluded directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)

    await store.writeFile(".git/objects/pack/data", { path: ".git/objects/pack/data", content: "ignored" })
    await store.writeFile("README.md", { path: "README.md", content: "included" })
    vi.mocked(readdir).mockClear()

    await expect(store.list("", { exclude: [".git"], recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "README.md", type: "file" }),
    ])
    expect(readdir).not.toHaveBeenCalledWith(join(root, ".git"), { withFileTypes: true })
  })

  it("treats normalized root exclusions as the whole Workspace", async () => {
    const store = await createStore()

    await store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })

    await expect(store.list("", { exclude: [""], recursive: true })).resolves.toEqual([])
    await expect(store.list("", { exclude: ["/"], recursive: true })).resolves.toEqual([])
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

    expect(vi.mocked(writeFile).mock.calls.every(call => String(call[0]).includes(".vitehub-file-metadata"))).toBe(true)
    await expect(store.readFile("assets/blob.bin")).resolves.toMatchObject({
      mediaType: "application/octet-stream",
      metadata: { source: "airtable" },
    })
  })

  it("persists file metadata across Store instances without exposing sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    await first.writeFile(".agents/skills/browser/SKILL.md", {
      path: ".agents/skills/browser/SKILL.md",
      content: "# Browser\n",
      mediaType: "text/markdown",
      metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
    })

    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile(".agents/skills/browser/SKILL.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
      metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
    })
    await expect(restarted.stat(".agents/skills/browser/SKILL.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
      metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
    })
    await expect(restarted.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ".agents/skills/browser/SKILL.md",
        mediaType: "text/markdown",
        metadata: { capabilityWorkspaceContribution: { capabilityId: "browser", digest: "owned" } },
      }),
    ]))
    await expect(restarted.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("vitehub-file-metadata") }),
    ]))

    await restarted.rm(".agents/skills/browser", { recursive: true })
    const afterRemoval = createLocalWorkspaceStore(root)
    await expect(afterRemoval.readFile(".agents/skills/browser/SKILL.md")).resolves.toBeUndefined()
  })

  it.each([
    { path: "file.txt", mediaType: 42, metadata: { owner: "browser" }, expected: { mediaType: undefined, metadata: { owner: "browser" } } },
    { path: "file.txt", mediaType: "text/plain", metadata: [], expected: { mediaType: "text/plain", metadata: undefined } },
    { path: "other.txt", mediaType: "text/plain", metadata: { owner: "browser" }, expected: { mediaType: undefined, metadata: undefined } },
  ])("validates persisted attributes at the file boundary: %j", async ({ expected, ...attributes }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    await createLocalWorkspaceStore(root).writeFile("file.txt", {
      path: "file.txt",
      content: "content",
      mediaType: "text/plain",
    })
    await writeFile(`${metadataRoot(root)}/file.txt/metadata.json`, JSON.stringify(attributes))
    await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject(expected)
  })

  it.each([undefined, { source: "old" }])("refreshes cached attributes after another Store writes: %j", async (metadata) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const reader = createLocalWorkspaceStore(root)
    const writer = createLocalWorkspaceStore(root)
    await writer.writeFile("file.txt", { path: "file.txt", content: "old", metadata })
    await expect(reader.readFile("file.txt")).resolves.toMatchObject({ metadata })

    await writer.writeFile("file.txt", {
      path: "file.txt",
      content: "new",
      mediaType: "text/plain",
      metadata: { source: "new" },
    })
    await expect(reader.readFile("file.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("new"),
      mediaType: "text/plain",
      metadata: { source: "new" },
    })

    // Attribute-only writes must invalidate the cache even when file bytes stay unchanged.
    await writer.writeFile("file.txt", { path: "file.txt", content: "new", metadata: { source: "updated" } })
    await expect(reader.stat("file.txt")).resolves.toMatchObject({ metadata: { source: "updated" } })
    await writer.writeFile("file.txt", { path: "file.txt", content: "new" })
    await expect(reader.list()).resolves.toEqual([
      expect.objectContaining({ path: "file.txt", mediaType: undefined, metadata: undefined }),
    ])
  })

  it("keeps metadata paths distinct for suffix-related Workspace paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    await first.writeFile("a", { path: "a", content: "first", metadata: { owner: "a" } })
    await first.writeFile("a.json/b", { path: "a.json/b", content: "second", metadata: { owner: "b" } })

    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile("a")).resolves.toMatchObject({ metadata: { owner: "a" } })
    await expect(restarted.readFile("a.json/b")).resolves.toMatchObject({ metadata: { owner: "b" } })

    await restarted.rm("a")
    const afterRemoval = createLocalWorkspaceStore(root)
    await expect(afterRemoval.readFile("a")).resolves.toBeUndefined()
    await expect(afterRemoval.readFile("a.json/b")).resolves.toMatchObject({ metadata: { owner: "b" } })
  })

  it("does not serialize unconditional writes behind the Workspace root lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const writing = store.writeFile("docs/readme.md", { path: "docs/readme.md", content: "hello" })
    await writingStarted

    await expect(stat(`${root}.vitehub-lock`)).rejects.toMatchObject({ code: "ENOENT" })
    const tempPath = String(vi.mocked(writeFile).mock.calls[0]?.[0])
    expect(tempPath.startsWith(`${root}/.vitehub/tmp/`)).toBe(true)
    await expect(store.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file" }),
    ]))
    release()
    await writing
  })

  it("allows unconditional sibling writes to overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const writing = first.writeFile("docs/first.md", { path: "docs/first.md", content: "first" })
    await writingStarted
    await second.writeFile("docs/second.md", { path: "docs/second.md", content: "second" })
    await expect(second.readFile("docs/second.md")).resolves.toMatchObject({ path: "docs/second.md" })

    release()
    await writing
  })

  it("preserves conditional-write isolation from concurrent unconditional writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    await first.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    const baseline = await first.stat("docs/page.md")
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const writing = second.writeFile("docs/page.md", { path: "docs/page.md", content: "second" })
    await writingStarted
    const conditional = first.writeFileConditional?.(
      "docs/page.md",
      { path: "docs/page.md", content: "stale" },
      baseline?.digest || null,
    )
    release()
    await writing

    await expect(conditional).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" })
    await expect(readFile(join(root, "docs/page.md"), "utf8")).resolves.toBe("second")
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

  it("serializes parent removal with a conditional child write", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const first = createLocalWorkspaceStore(root)
    const second = createLocalWorkspaceStore(root)
    await first.writeFile("docs/page.md", { path: "docs/page.md", content: "first" })
    const baseline = await first.stat("docs/page.md")
    const { writeFile: actualWriteFile } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let release!: () => void
    let signalWriting!: () => void
    const writingStarted = new Promise<void>((resolve) => { signalWriting = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      signalWriting()
      await blocked
      return await actualWriteFile(...args)
    })

    const conditional = first.writeFileConditional?.(
      "docs/page.md",
      { path: "docs/page.md", content: "second" },
      baseline?.digest || null,
    )
    await writingStarted
    const removing = second.rm("docs", { recursive: true })
    let removed = false
    void removing.then(() => { removed = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(removed).toBe(false)

    release()
    await conditional
    await removing
    await expect(first.stat("docs/page.md")).resolves.toBeUndefined()
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

    expect(vi.mocked(writeFile).mock.calls.every(call => String(call[0]).includes(".vitehub-file-metadata"))).toBe(true)
    await expect(store.readFile("assets/blob.bin")).resolves.toMatchObject({
      content,
      mediaType: "application/octet-stream",
      metadata: { source: "stream" },
    })
  })

  it("does not serialize unconditional streamed writes behind the Workspace root lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-store-"))
    tempDirs.push(root)
    const store = createLocalWorkspaceStore(root)
    let release!: () => void
    let signalWaiting!: () => void
    const waiting = new Promise<void>((resolve) => { signalWaiting = resolve })
    const content = (async function* () {
      yield new Uint8Array([0, 1, 2, 3])
      await new Promise<void>((resolve) => {
        release = resolve
        signalWaiting()
      })
    })()

    const writing = store.writeFileStream?.("assets/blob.bin", {
      path: "assets/blob.bin",
      content,
    })
    await waiting

    await expect(stat(`${root}.vitehub-lock`)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(store.list("", { recursive: true })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file" }),
    ]))
    release()
    await writing
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
