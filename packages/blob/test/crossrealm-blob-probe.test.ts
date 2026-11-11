import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

import { createBlobStorage } from "../src/storage.ts"

describe("cross realm Blob bodies", () => {
  it("preserves a native Blob type without a local prototype", async () => {
    // Node VM contexts do not supply their own Blob implementation. This
    // fixture tests the instanceof fallback with real native internal slots;
    // it does not claim to exercise browser iframe globals.
    const body: Blob = runInNewContext(`(() => {
      const body = new Blob(["payload"], { type: "image/x-custom" })
      const prototype = Object.create(null, Object.getOwnPropertyDescriptors(Blob.prototype))
      Object.setPrototypeOf(body, prototype)
      return body
    })()`, { Blob })
    expect(body instanceof Blob).toBe(false)
    expect(body.type).toBe("image/x-custom")
    expect(body.size).toBe(7)
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

    await expect(storage.put("file.bin", body as never)).resolves.toMatchObject([undefined, { contentType: "image/x-custom" }])
  })
})
