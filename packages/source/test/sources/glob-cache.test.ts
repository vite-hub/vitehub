import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { glob as tinyglobby } from "tinyglobby"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createSource } from "../../src/core/reader.ts"
import { glob } from "../../src/glob.ts"

vi.mock("tinyglobby", () => ({
  glob: vi.fn(async () => ["docs/README.md"]),
}))

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-source-glob-cache-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("@vite-hub/source glob source cache", () => {
  it("keeps public key mutations separate from cached membership", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")
    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }

    const keys = await docs.getKeys(ctx)
    keys.splice(0, 1, "missing.md")
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    await expect(docs.getItem("docs/README.md", ctx)).resolves.toMatchObject({ key: "docs/README.md" })
    await expect(docs.getMeta?.("docs/README.md", ctx)).resolves.toMatchObject({ digest: expect.any(String) })
    await expect(docs.getItem("missing.md", ctx)).rejects.toThrow('glob could not find "missing.md"')

    const reader = createSource(docs, ctx)
    const readerKeys = await reader.keys()
    readerKeys.splice(0, 1, "missing.md")
    await expect(reader.keys()).resolves.toEqual(["docs/README.md"])
    await expect(reader.exists("docs/README.md")).resolves.toBe(true)
    await expect(reader.exists("missing.md")).resolves.toBe(false)
    await expect(reader.get("docs/README.md")).resolves.toMatchObject({ key: "docs/README.md" })
    await expect(reader.meta("docs/README.md")).resolves.toMatchObject({ digest: expect.any(String) })
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })

  it("reuses a prepared glob listing for item reads and metadata", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }

    await docs.prepare?.(ctx)
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    await expect(docs.getItem("docs/README.md", ctx)).resolves.toMatchObject({ key: "docs/README.md" })
    await expect(docs.getMeta?.("docs/README.md", ctx)).resolves.toMatchObject({ digest: expect.any(String) })

    expect(tinyglobby).toHaveBeenCalledTimes(1)
  })

  it("can refresh glob keys on each read", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")
    vi.mocked(tinyglobby)
      .mockResolvedValueOnce(["docs/README.md"])
      .mockResolvedValueOnce(["docs/README.md", "docs/guide.md"])

    const docs = glob({ include: "**/*.md", keyCache: false })
    const ctx = { rootDir: root }

    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/guide.md", "docs/README.md"])
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })

  it("evicts rejected glob listings from the key cache", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    vi.mocked(tinyglobby)
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(["docs/README.md"])

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }

    await expect(docs.getKeys(ctx)).rejects.toThrow("transient failure")
    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })

  it("shares one in-flight glob listing across concurrent key reads", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    vi.mocked(tinyglobby).mockResolvedValueOnce(["docs/README.md"])

    const docs = glob({ include: "**/*.md" })
    const ctx = { rootDir: root }

    await expect(Promise.all([docs.getKeys(ctx), docs.getKeys(ctx)])).resolves.toEqual([
      ["docs/README.md"],
      ["docs/README.md"],
    ])
    expect(tinyglobby).toHaveBeenCalledTimes(1)
  })

  it("keeps concurrent listings separate for different contexts at the same root", async () => {
    const root = await createRoot()
    function pendingListing() {
      let resolve!: (keys: string[]) => void
      const promise = new Promise<string[]>((done) => { resolve = done })
      return { promise, resolve }
    }
    const listings = [pendingListing(), pendingListing()]
    vi.mocked(tinyglobby)
      .mockImplementationOnce(() => listings[0]!.promise)
      .mockImplementationOnce(() => listings[1]!.promise)
    const docs = glob({ include: "**/*.md" })
    const contexts = [{ rootDir: root }, { rootDir: root }]
    const pending = contexts.map(ctx => docs.getKeys(ctx))

    await vi.waitFor(() => expect(tinyglobby).toHaveBeenCalledTimes(2))
    listings[1]!.resolve(["second.md"])
    listings[0]!.resolve(["first.md"])
    const results = await Promise.all(pending)
    expect(results.map(keys => keys[0]).sort()).toEqual(["first.md", "second.md"])
    await expect(Promise.all(contexts.map(ctx => docs.getKeys(ctx)))).resolves.toEqual(results)
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })

  it("reprepares only the selected context", async () => {
    const root = await createRoot()
    vi.mocked(tinyglobby)
      .mockResolvedValueOnce(["first.md"])
      .mockResolvedValueOnce(["second.md"])
      .mockResolvedValueOnce(["refreshed.md"])
    const docs = glob({ include: "**/*.md" })
    const first = { rootDir: root }
    const second = { rootDir: root }

    await docs.prepare?.(first)
    await docs.prepare?.(second)
    await docs.prepare?.(first)

    await expect(docs.getKeys(first)).resolves.toEqual(["refreshed.md"])
    await expect(docs.getKeys(second)).resolves.toEqual(["second.md"])
    expect(tinyglobby).toHaveBeenCalledTimes(3)
  })

  it.each([true, false])("drops removed keys after refreshing with keyCache=%s", async (keyCache) => {
    const root = await createRoot()
    await writeFile(join(root, "old.md"), "# Old\n")
    await writeFile(join(root, "new.md"), "# New\n")
    vi.mocked(tinyglobby)
      .mockResolvedValueOnce(["old.md"])
      .mockResolvedValueOnce(["new.md"])
    if (!keyCache) {
      vi.mocked(tinyglobby)
        .mockResolvedValueOnce(["new.md"])
        .mockResolvedValueOnce(["new.md"])
    }
    const docs = glob({ include: "*.md", keyCache })
    const ctx = { rootDir: root }

    await docs.prepare?.(ctx)
    await expect(docs.getItem("old.md", ctx)).resolves.toMatchObject({ key: "old.md" })
    if (keyCache) await docs.prepare?.(ctx)
    else await docs.getKeys(ctx)

    await expect(docs.getItem("new.md", ctx)).resolves.toMatchObject({ key: "new.md" })
    await expect(docs.getMeta?.("new.md", ctx)).resolves.toMatchObject({ digest: expect.any(String) })
    await expect(docs.getItem("old.md", ctx)).rejects.toThrow('glob could not find "old.md"')
    await expect(docs.getMeta?.("old.md", ctx)).rejects.toThrow('glob could not find "old.md"')
  })

  it("reuses live glob listings for item reads and refreshes missing keys", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n")
    vi.mocked(tinyglobby)
      .mockResolvedValueOnce(["docs/README.md"])
      .mockResolvedValueOnce(["docs/README.md", "docs/guide.md"])

    const docs = glob({ include: "**/*.md", keyCache: false })
    const ctx = { rootDir: root }

    await expect(docs.getKeys(ctx)).resolves.toEqual(["docs/README.md"])
    await expect(docs.getItem("docs/README.md", ctx)).resolves.toMatchObject({ key: "docs/README.md" })
    await expect(docs.getMeta?.("docs/README.md", ctx)).resolves.toMatchObject({ digest: expect.any(String) })
    expect(tinyglobby).toHaveBeenCalledTimes(1)

    await expect(docs.getItem("docs/guide.md", ctx)).resolves.toMatchObject({ key: "docs/guide.md" })
    expect(tinyglobby).toHaveBeenCalledTimes(2)
  })
})
