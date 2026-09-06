import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { MemoryFS } from "../src/storage/memory-fs.ts"

describe("Workspace MemoryFS", () => {
  it("exposes Node-style clone errors and symlink methods", async () => {
    const fs = new MemoryFS()

    await expect(fs.promises.readFile("/missing")).rejects.toMatchObject({ code: "ENOENT" })
    await fs.promises.writeFile("/file", "content")
    await expect(fs.promises.readlink("/file")).rejects.toMatchObject({ code: "EINVAL" })
    await expect(fs.promises.symlink("/target", "/link")).rejects.toMatchObject({
      code: "ENOTSUP",
    })
  })

  it("rejects file and directory collisions without corrupting the tree", async () => {
    const fs = new MemoryFS()

    await fs.promises.writeFile("/file", "content")
    await expect(fs.promises.mkdir("/file", { recursive: true })).rejects.toMatchObject({ code: "EEXIST" })
    await expect(fs.promises.mkdir("/file/child", { recursive: true })).rejects.toMatchObject({ code: "ENOTDIR" })
    await expect(fs.promises.writeFile("/file/child", "content")).rejects.toMatchObject({ code: "ENOTDIR" })
    expect(fs.entries.has("/file/child")).toBe(false)

    await fs.promises.mkdir("/directory")
    await expect(fs.promises.mkdir("/directory")).rejects.toMatchObject({ code: "EEXIST" })
    await expect(fs.promises.mkdir("/")).rejects.toMatchObject({ code: "EEXIST" })
    await expect(fs.promises.mkdir("/directory", { recursive: true })).resolves.toBeUndefined()
    await expect(fs.promises.mkdir("/", { recursive: true })).resolves.toBeUndefined()
    await expect(fs.promises.writeFile("/directory", "replacement")).rejects.toMatchObject({ code: "EISDIR" })
    expect((await fs.promises.stat("/directory")).isDirectory()).toBe(true)

    await expect(fs.promises.rmdir("/")).rejects.toMatchObject({ code: "EBUSY" })
    expect((await fs.promises.stat("/")).isDirectory()).toBe(true)
  })

  it("copies binary data across the filesystem boundary", async () => {
    const fs = new MemoryFS()
    const input = new Uint8Array([1, 2, 3])
    const arrayBuffer = new Uint8Array([4, 5, 6]).buffer
    const buffer = Buffer.from([7, 8, 9])
    // SAFETY: Node's VM evaluates the exact binary object literal owned by this fixture.
    const crossRealm = runInNewContext(
      "({ bytes: new Uint8Array([10, 11, 12]), buffer: new Uint8Array([13, 14, 15]).buffer })",
    ) as {
      buffer: ArrayBuffer
      bytes: Uint8Array
    }

    await fs.promises.writeFile("/file", input)
    await fs.promises.writeFile("/array-buffer", arrayBuffer)
    await fs.promises.writeFile("/buffer", buffer)
    await fs.promises.writeFile("/cross-realm-bytes", crossRealm.bytes)
    await fs.promises.writeFile("/cross-realm-buffer", crossRealm.buffer)
    input[0] = 9
    new Uint8Array(arrayBuffer)[0] = 9
    buffer[0] = 9
    crossRealm.bytes[0] = 9
    new Uint8Array(crossRealm.buffer)[0] = 9
    const firstRead = await fs.promises.readFile("/file")
    if (!(firstRead instanceof Uint8Array)) throw new TypeError("Expected a binary read result.")
    firstRead[1] = 9
    const bufferRead = await fs.promises.readFile("/buffer")
    if (!(bufferRead instanceof Uint8Array)) throw new TypeError("Expected a binary read result.")
    Buffer.from(bufferRead.buffer, bufferRead.byteOffset, bufferRead.byteLength)[1] = 9

    expect(await fs.promises.readFile("/file")).toEqual(new Uint8Array([1, 2, 3]))
    expect(await fs.promises.readFile("/array-buffer")).toEqual(new Uint8Array([4, 5, 6]))
    expect(await fs.promises.readFile("/buffer")).toEqual(new Uint8Array([7, 8, 9]))
    expect(await fs.promises.readFile("/cross-realm-bytes")).toEqual(new Uint8Array([10, 11, 12]))
    expect(await fs.promises.readFile("/cross-realm-buffer")).toEqual(new Uint8Array([13, 14, 15]))
  })
})
