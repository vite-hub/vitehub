import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createBlobStorage } from "../src/storage.ts"

describe("cross realm Blob bodies", () => {
  it("preserves a Blob type from another realm", async () => {
    const body = runInNewContext(`
      const body = Object.create(null)
      Object.defineProperty(body, Symbol.toStringTag, { value: "Blob" })
      Object.defineProperty(body, "type", { value: "image/x-custom" })
      body
    `) as Blob
    const driver = {
      name: "probe",
      options: {},
      async put(_pathname: string, _body: unknown, options: { contentType?: string }) {
        return {
          contentType: options.contentType,
          customMetadata: {},
          httpEtag: undefined,
          httpMetadata: options.contentType ? { contentType: options.contentType } : {},
          pathname: "file.bin",
          uploadedAt: new Date(),
        }
      },
    }
    const storage = createBlobStorage(driver as never)

    await expect(storage.put("file.bin", body as never)).resolves.toMatchObject([null, { contentType: "image/x-custom" }])
  })
})
