import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")

const tempDirs: string[] = []

afterEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(fs.rename)
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function store() {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-folder-keys-"))
  tempDirs.push(base)
  return { base, driver: createDriver({ base, driver: "fs" }) }
}

async function text(blob: Blob | null) {
  return blob ? await blob.text() : null
}

// S3, R2, and Vercel Blob keep `docs` and `docs/a.txt` apart. A folder holds `docs/a.txt`, so `docs` cannot be a file.
describe("fs blob driver: a pathname that is also a folder", () => {
  it.each([
    ["docs", "docs/a.txt"],
    ["docs/a.txt", "docs"],
  ])("stores %s and then %s", async (first, second) => {
    const { driver } = await store()
    await driver.put(first, first, { contentType: "text/plain", customMetadata: { name: first } })
    await driver.put(second, second, { contentType: "text/plain", customMetadata: { name: second } })

    for (const pathname of ["docs", "docs/a.txt"]) {
      expect(await text(await driver.get(pathname))).toBe(pathname)
      expect(new TextDecoder().decode((await driver.getArrayBuffer(pathname))!)).toBe(pathname)
      await expect(driver.head(pathname)).resolves.toMatchObject({ contentType: "text/plain", customMetadata: { name: pathname }, pathname, size: pathname.length })
    }
    expect((await driver.list()).blobs.map(blob => blob.pathname)).toEqual(["docs", "docs/a.txt"])
    await expect(driver.list({ folded: true })).resolves.toMatchObject({ blobs: [{ pathname: "docs" }], folders: ["docs/"] })
    await expect(driver.list({ folded: true, prefix: "docs/" })).resolves.toMatchObject({ blobs: [{ pathname: "docs/a.txt" }], folders: [] })
  })

  it.each(["docs/a.txt", "docs/nested/a.txt"])("copies a file into its descendant %s", async (destination) => {
    const { driver } = await store()
    await driver.put("docs", "parent", { contentType: "text/plain", customMetadata: { name: "parent" } })
    await expect(driver.copy!("docs", destination)).resolves.toMatchObject({ pathname: destination, contentType: "text/plain", customMetadata: { name: "parent" } })
    for (const pathname of ["docs", destination]) {
      expect(await text(await driver.get(pathname))).toBe("parent")
      await expect(driver.head(pathname)).resolves.toMatchObject({ contentType: "text/plain", customMetadata: { name: "parent" } })
    }
  })

  it("recovers when a sibling writer completes an observed promotion", async () => {
    const { base, driver } = await store()
    await driver.put("docs", "parent", { contentType: "text/plain", customMetadata: { name: "parent" } })
    const paused = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let intercepted = false
    vi.mocked(rename).mockImplementation(async (...args) => {
      if (args[0] === join(base, "docs") && !intercepted) {
        intercepted = true
        paused.resolve()
        await resume.promise
      }
      return fs.rename(...args)
    })
    const first = driver.put("docs/a.txt", "first")
    // Attach a handler before allowing the paused operation to fail on the old code.
    const result = Promise.all([first])
    await paused.promise
    try {
      await driver.put("docs/b.txt", "second")
    }
    finally {
      resume.resolve()
    }
    await result
    expect(await text(await driver.get("docs/a.txt"))).toBe("first")
    expect(await text(await driver.get("docs/b.txt"))).toBe("second")
    expect(await text(await driver.get("docs"))).toBe("parent")
    await expect(driver.head("docs")).resolves.toMatchObject({ contentType: "text/plain", customMetadata: { name: "parent" } })
  })

  it("lists keys in order around a key that is also a folder, across pages", async () => {
    const { driver } = await store()
    for (const pathname of ["docs/a.txt", "docs", "docs!", "docs-x", "docs.txt", "doc", "docs/b/c.txt", "docs/b"]) await driver.put(pathname, pathname)

    const expected = ["doc", "docs", "docs!", "docs-x", "docs.txt", "docs/a.txt", "docs/b", "docs/b/c.txt"]
    expect((await driver.list()).blobs.map(blob => blob.pathname)).toEqual(expected)
    const paged: string[] = []
    let cursor: string | undefined
    do {
      const page = await driver.list({ cursor, limit: 2 })
      paged.push(...page.blobs.map(blob => blob.pathname))
      cursor = page.cursor
    } while (cursor)
    expect(paged).toEqual(expected)
    await expect(driver.list({ folded: true, prefix: "docs/" })).resolves.toMatchObject({ blobs: [{ pathname: "docs/a.txt" }, { pathname: "docs/b" }], folders: ["docs/b/"] })
  })

  it("deletes one key and keeps the other", async () => {
    const { driver } = await store()
    await driver.put("docs", "parent")
    await driver.put("docs/a.txt", "child")

    await driver.delete("docs")
    await expect(driver.head("docs")).resolves.toBeNull()
    expect(await text(await driver.get("docs/a.txt"))).toBe("child")
    expect((await driver.list()).blobs.map(blob => blob.pathname)).toEqual(["docs/a.txt"])

    await driver.put("docs", "again")
    await driver.delete("docs/a.txt")
    expect(await text(await driver.get("docs"))).toBe("again")
    expect((await driver.list()).blobs.map(blob => blob.pathname)).toEqual(["docs"])
    await expect(driver.list({ folded: true })).resolves.toMatchObject({ blobs: [{ pathname: "docs" }], folders: [] })
  })

  it("replaces a key that is also a folder, and copies to and from it", async () => {
    const { driver } = await store()
    await driver.put("docs/a.txt", "child")
    await driver.put("docs", "one")
    await driver.put("docs", "two", { contentType: "text/markdown" })
    expect(await text(await driver.get("docs"))).toBe("two")

    await expect(driver.copy!("docs", "notes")).resolves.toMatchObject({ contentType: "text/markdown", pathname: "notes" })
    await driver.put("notes/b.txt", "nested")
    await expect(driver.copy!("notes", "docs/a.txt")).resolves.toMatchObject({ pathname: "docs/a.txt" })
    expect(await text(await driver.get("notes"))).toBe("two")
    expect(await text(await driver.get("docs/a.txt"))).toBe("two")
  })

  it("reads a folder without a key of its own as missing", async () => {
    const { base, driver } = await store()
    await driver.put("docs/a.txt", "child")

    await expect(driver.head("docs")).resolves.toBeNull()
    await expect(driver.get("docs")).resolves.toBeNull()
    await expect(driver.getArrayBuffer("docs")).resolves.toBeNull()
    await expect(driver.delete("docs")).resolves.toBeUndefined()
    expect(await readdir(join(base, "docs"))).toEqual(["a.txt"])
  })

  it("reads files that an older version stored, and keeps them where they are", async () => {
    const { base } = await store()
    // The layout of older versions: every key is the file at its pathname.
    await mkdir(join(base, "docs"), { recursive: true })
    await writeFile(join(base, "docs/a.txt"), "child")
    await writeFile(join(base, "readme"), "root")
    const driver = createDriver({ base, driver: "fs" })

    expect((await driver.list()).blobs.map(blob => blob.pathname)).toEqual(["docs/a.txt", "readme"])
    await driver.put("readme/notes.txt", "nested")
    expect(await text(await driver.get("readme"))).toBe("root")
    expect(await text(await driver.get("docs/a.txt"))).toBe("child")
    expect(await readdir(join(base, "docs"))).toEqual(["a.txt"])
  })
})
