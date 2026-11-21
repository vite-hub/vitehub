import { afterEach, expect, it } from "vitest"

import { normalizeBlobOptions } from "../src/config.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"
import { blob } from "../src/runtime/storage.ts"

afterEach(() => setBlobRuntimeConfig(false))

it("reports the missing R2 binding instead of trying to write to the Worker filesystem", async () => {
  setBlobRuntimeConfig(normalizeBlobOptions({ binding: "TASK_ASSETS", driver: "cloudflare" }, { dev: true, env: {}, hosting: "cloudflare" }))

  const [error] = await blob.put("review/hello.txt", "hello")

  expect(error).toMatchObject({
    cause: { code: "BLOB_R0001", message: expect.stringContaining('R2 binding "TASK_ASSETS" not found') },
    code: "BLOB_OPERATION_FAILED",
  })
})
