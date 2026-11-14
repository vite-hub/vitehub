import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, readdir: vi.fn(fs.readdir), readFile: vi.fn(fs.readFile), stat: vi.fn(fs.stat) }
})

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const directories: string[] = []

afterEach(async () => {
  vi.mocked(readdir).mockClear()
  vi.mocked(readFile).mockClear()
  vi.mocked(stat).mockReset().mockImplementation(fs.stat)
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it("hashes only the files in each requested page", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  const names = Array.from({ length: 16 }, (_, index) => `${String(index).padStart(2, "0")}.txt`)
  const bytes = Buffer.alloc(64 * 1024, "x")
  await Promise.all(names.map(name => writeFile(join(base, name), bytes)))
  const paths = new Set(names.map(name => join(base, name)))
  const driver = createDriver({ base, driver: "fs" })
  let cursor: string | undefined

  for (let offset = 0; offset < names.length; offset += 2) {
    vi.mocked(readFile).mockClear()
    const page = await driver.list({ cursor, limit: 2 })
    expect(page.blobs.map(blob => blob.pathname)).toEqual(names.slice(offset, offset + 2))
    expect(page.blobs).toEqual(names.slice(offset, offset + 2).map(pathname => expect.objectContaining({
      httpEtag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      pathname,
      size: bytes.length,
    })))
    const payloadReads = vi.mocked(readFile).mock.calls.filter(([path]) => paths.has(String(path)))
    expect(payloadReads).toHaveLength(2)
    expect(page.hasMore).toBe(offset + 2 < names.length)
    cursor = page.cursor
  }
  expect(cursor).toBeUndefined()
})

it.each([false, true])("does not read file contents for a zero limit (folded: %s)", async (folded) => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  await writeFile(join(base, "one.txt"), "one")
  const page = await createDriver({ base, driver: "fs" }).list({ folded, limit: 0 })

  expect(page).toMatchObject({ blobs: [], cursor: expect.any(String), hasMore: true })
  expect(readFile).not.toHaveBeenCalled()
})

it.each([false, true])("does not skip the next key when a selected file disappears (folded: %s)", async (folded) => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  await writeFile(join(base, "a.txt"), "a")
  await writeFile(join(base, "b.txt"), "b")
  const driver = createDriver({ base, driver: "fs" })
  vi.mocked(stat).mockImplementationOnce(async path => {
    await rm(path)
    return fs.stat(path, { bigint: true })
  })

  const first = await driver.list({ folded, limit: 1 })
  const second = await driver.list({ folded, limit: 1, cursor: first.cursor })

  expect([...first.blobs, ...second.blobs].map(blob => blob.pathname)).toContain("b.txt")
  expect(second.hasMore).toBe(false)
})

it("reads only the direct blobs selected for each folded page", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-folded-"))
  directories.push(base)
  await mkdir(join(base, "a-folder"))
  const nested = Array.from({ length: 16 }, (_, index) => `a-folder/${index}.txt`)
  const direct = ["b.txt", "c.txt"]
  const names = [...nested, ...direct]
  const bytes = Buffer.alloc(64 * 1024, "x")
  await Promise.all(names.map(name => writeFile(join(base, name), bytes)))
  const paths = new Set(names.map(name => join(base, name)))
  const driver = createDriver({ base, driver: "fs" })
  let cursor: string | undefined

  for (let index = 0; index < direct.length; index++) {
    vi.mocked(readFile).mockClear()
    const page = await driver.list({ cursor, folded: true, limit: 1 })
    expect(page.blobs).toEqual([expect.objectContaining({
      httpEtag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      pathname: direct[index],
      size: bytes.length,
    })])
    expect(page.folders).toEqual(index === 0 ? ["a-folder/"] : [])
    expect(page.hasMore).toBe(index === 0)
    const payloadReads = vi.mocked(readFile).mock.calls.filter(([path]) => paths.has(String(path)))
    expect(payloadReads).toHaveLength(1)
    cursor = page.cursor
  }
  expect(cursor).toBeUndefined()
})

async function folderFixture(folders: number, files: number) {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  for (let folder = 0; folder < folders; folder++) {
    await mkdir(join(base, `f${folder}`))
    await Promise.all(Array.from({ length: files }, (_, file) => writeFile(join(base, `f${folder}`, `${file}.txt`), "x")))
  }
  return { base, driver: createDriver({ base, driver: "fs" }) }
}

function blobDirectoryReads(base: string) {
  const internal = join(base, ".vitehub")
  return vi.mocked(readdir).mock.calls.map(([path]) => String(path)).filter(path => path !== internal && !path.startsWith(`${internal}/`))
}

it("reads only the directories on the prefix path", async () => {
  const { base, driver } = await folderFixture(5, 3)
  vi.mocked(readdir).mockClear()

  const page = await driver.list({ prefix: "f3/" })

  expect(page.blobs.map(blob => blob.pathname)).toEqual(["f3/0.txt", "f3/1.txt", "f3/2.txt"])
  expect(blobDirectoryReads(base)).toEqual([base, join(base, "f3")])
})

it("reads only the directories a page reaches", async () => {
  const { base, driver } = await folderFixture(5, 3)
  const first = await driver.list({ limit: 4 })
  vi.mocked(readdir).mockClear()

  const second = await driver.list({ cursor: first.cursor, limit: 4 })

  expect(second.blobs.map(blob => blob.pathname)).toEqual(["f1/1.txt", "f1/2.txt", "f2/0.txt", "f2/1.txt"])
  expect(blobDirectoryReads(base)).toEqual([base, join(base, "f1"), join(base, "f2")])
})

it.each([false, true])("does not repeat or skip keys when a key is added between pages (folded: %s)", async (folded) => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  await Promise.all(["b.txt", "d.txt", "f.txt"].map(name => writeFile(join(base, name), name)))
  const driver = createDriver({ base, driver: "fs" })

  const first = await driver.list({ folded, limit: 2 })
  await writeFile(join(base, "a.txt"), "a")
  await writeFile(join(base, "e.txt"), "e")
  const second = await driver.list({ cursor: first.cursor, folded, limit: 2 })

  expect(first.blobs.map(blob => blob.pathname)).toEqual(["b.txt", "d.txt"])
  expect(second.blobs.map(blob => blob.pathname)).toEqual(["e.txt", "f.txt"])
  expect(second.hasMore).toBe(false)
})

it("sorts keys by code unit so a folder stays next to its keys", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  const driver = createDriver({ base, driver: "fs" })
  for (const pathname of ["a/b.txt", "a.txt", "B.txt", "a-c.txt", "a0.txt"]) await driver.put(pathname, pathname)

  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await driver.list({ cursor, limit: 1 })
    keys.push(...page.blobs.map(blob => blob.pathname))
    cursor = page.cursor
  } while (cursor)

  expect(keys).toEqual(["B.txt", "a-c.txt", "a.txt", "a/b.txt", "a0.txt"])
})
