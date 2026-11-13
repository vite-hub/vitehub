import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})

const directories: string[] = []

afterEach(async () => {
  vi.mocked(readFile).mockClear()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-multipart-"))
  directories.push(base)
  const driver = createDriver({ base, driver: "fs" })
  if (!driver.createMultipartUpload) throw new Error("The fs driver must support multipart uploads.")
  const upload = await driver.createMultipartUpload("media/clip.bin", { contentType: "video/mp4", customMetadata: { owner: "ana" } })
  const second = await upload.uploadPart(2, new Uint8Array(70 * 1024).fill(2))
  const first = await upload.uploadPart(1, new Uint8Array(70 * 1024).fill(1))
  return { base, driver, first, second, upload }
}

it("streams parts into the final file without reading whole files", async () => {
  const { base, driver, first, second, upload } = await fixture()
  vi.mocked(readFile).mockClear()

  const object = await upload.complete([second, first])

  const payloadReads = vi.mocked(readFile).mock.calls.map(([path]) => String(path)).filter(path => !path.endsWith(".json"))
  expect(payloadReads).toEqual([])
  const bytes = new Uint8Array([...new Uint8Array(70 * 1024).fill(1), ...new Uint8Array(70 * 1024).fill(2)])
  expect(object).toMatchObject({
    contentType: "video/mp4",
    customMetadata: { owner: "ana" },
    httpEtag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    pathname: "media/clip.bin",
    size: bytes.length,
  })
  expect(new Uint8Array(await (await driver.get("media/clip.bin"))!.arrayBuffer())).toEqual(bytes)
  expect(await driver.head("media/clip.bin")).toEqual(object)
  await expect(readdir(join(base, ".vitehub", "multipart"))).resolves.toEqual([])
  await expect(readdir(join(base, ".vitehub", "blob-writes"))).resolves.toEqual([])
})

it("publishes nothing when a part does not match its etag", async () => {
  const { base, driver, first, second, upload } = await fixture()

  await expect(upload.complete([first, { ...second, etag: "\"changed\"" }])).rejects.toMatchObject({ code: "BLOB_R0032" })

  await expect(driver.head("media/clip.bin")).resolves.toBeNull()
  await expect(readdir(join(base, ".vitehub", "blob-writes")).catch(() => [])).resolves.toEqual([])
  await expect(upload.complete([first, second])).resolves.toMatchObject({ pathname: "media/clip.bin" })
})

it("publishes nothing when a part is missing", async () => {
  const { driver, first, upload } = await fixture()

  await expect(upload.complete([first, { etag: first.etag, partNumber: 3 }])).rejects.toMatchObject({ code: "BLOB_R0032", message: expect.stringContaining("has no part 3") })

  await expect(driver.head("media/clip.bin")).resolves.toBeNull()
})
