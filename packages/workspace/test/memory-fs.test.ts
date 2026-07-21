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
})
