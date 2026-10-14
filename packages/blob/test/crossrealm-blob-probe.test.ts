import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

import { createBlobStorage } from "../src/storage.ts"
import ForeignBlob from "fetch-blob"

describe("cross realm Blob bodies", () => {
  it("preserves a Blob type from another realm", async () => {
    // Node VM contexts do not install web globals. Use an independent Blob
    // implementation and construct the value inside the VM context.
    const body: Blob = runInNewContext(`(() => {
      const body = new Blob(["payload"], { type: "image/x-custom" })
      return body
    })()`, { Blob: ForeignBlob })
    expect(body instanceof Blob).toBe(false)
    await expect(body.text()).resolves.toBe("payload")
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

  it("ignores spoofed Blob metadata on a supported byte body", async () => {
    const body: Uint8Array = runInNewContext(`(() => {
      const body = new Uint8Array([1, 2, 3])
      Object.defineProperty(body, Symbol.toStringTag, { value: "Blob" })
      Object.defineProperty(body, "type", { value: "image/x-spoofed" })
      return body
    })()`)
    const put = vi.fn(async (_pathname: string, _body: unknown, options: { contentType?: string }) => ({
      contentType: options.contentType,
      customMetadata: {},
      httpMetadata: options.contentType ? { contentType: options.contentType } : {},
      pathname: "file.bin",
      uploadedAt: new Date(),
    }))
    const storage = createBlobStorage({ name: "probe", options: {}, put } as never)

    await expect(storage.put("file.bin", body)).resolves.toMatchObject([null, { contentType: "application/octet-stream" }])
    expect(put).toHaveBeenCalledWith("file.bin", body, { contentType: "application/octet-stream" })
  })

  it("rejects metadata getters on a non-Blob prototype", async () => {
    const body: Uint8Array = new Uint8Array([1, 2, 3])
    const spoof = Object.create(Object.getPrototypeOf(body))
    Object.defineProperties(spoof, {
      type: { get: () => "image/x-spoofed" },
      size: { get: () => 999 },
    })
    Object.setPrototypeOf(body, spoof)
    const put = vi.fn(async (_pathname: string, _body: unknown, options: { contentType?: string }) => ({
      contentType: options.contentType,
      customMetadata: {},
      httpMetadata: options.contentType ? { contentType: options.contentType } : {},
      pathname: "file.bin",
      uploadedAt: new Date(),
    }))
    const storage = createBlobStorage({ name: "probe", options: {}, put } as never)

    await expect(storage.put("file.bin", body)).resolves.toMatchObject([null, { contentType: "application/octet-stream" }])
    expect(put).toHaveBeenCalledWith("file.bin", body, { contentType: "application/octet-stream" })
  })
})
