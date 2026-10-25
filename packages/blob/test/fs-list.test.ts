import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, readFile: vi.fn(fs.readFile), stat: vi.fn(fs.stat) }
})

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const directories: string[] = []

afterEach(async () => {
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

it("does not read file contents for a zero limit", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  await writeFile(join(base, "one.txt"), "one")
  const page = await createDriver({ base, driver: "fs" }).list({ limit: 0 })

  expect(page).toMatchObject({ blobs: [], cursor: expect.any(String), hasMore: true })
  expect(readFile).not.toHaveBeenCalled()
})

it("does not skip the next key when a selected file disappears", async () => {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-list-"))
  directories.push(base)
  await writeFile(join(base, "a.txt"), "a")
  await writeFile(join(base, "b.txt"), "b")
  const driver = createDriver({ base, driver: "fs" })
  vi.mocked(stat).mockImplementationOnce(async path => {
    await rm(path)
    return fs.stat(path, { bigint: true })
  })

  const first = await driver.list({ limit: 1 })
  const second = await driver.list({ limit: 1, cursor: first.cursor })

  expect([...first.blobs, ...second.blobs].map(blob => blob.pathname)).toContain("b.txt")
  expect(second.hasMore).toBe(false)
})
