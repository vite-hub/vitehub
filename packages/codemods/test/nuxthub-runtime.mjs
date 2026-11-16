// Load sibling runtime sources without adding them to the codemods TypeScript project.
import { join } from "node:path"

import { defineEventHandler, H3 } from "h3"

import { normalizeBlobOptions } from "../../blob/src/config.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createCloudflareR2Bindings } from "../../blob/src/internal/nitro-runtime.ts"
import { createBlobStorage } from "../../blob/src/storage.ts"
import { normalizeKVOptions } from "../../kv/src/config.ts"
import createCloudflareKVLocalDriver from "../../kv/src/runtime/cloudflare-kv-local.ts"

export async function serveMigratedRoute(code, directory) {
  const storage = createBlobStorage(createDriver({ driver: "fs", base: join(directory, "objects") }))
  const [error] = await storage.put("hello.txt", "hello", { contentType: "text/plain" })
  if (error) throw error
  const handler = new Function("defineEventHandler", "blob", code.replace("export default", "return"))(defineEventHandler, storage)
  const server = new H3().get("/**", handler)
  return {
    response: await server.request("http://localhost/hello.txt"),
    missing: await server.request("http://localhost/missing.txt"),
  }
}

export function blobBindings(options) {
  return createCloudflareR2Bindings(normalizeBlobOptions(options, { env: {}, hosting: "cloudflare" }))
}

export async function readLocalKV(directory, binding) {
  const config = normalizeKVOptions({ driver: "cloudflare-kv-binding", binding, namespaceId: "namespace" }, { dev: true, hosting: "cloudflare", env: {} })
  const store = config?.store
  if (store?.driver !== "cloudflare-kv-binding" || !store.localBase) throw new Error("Expected a local Cloudflare KV store")
  const driver = createCloudflareKVLocalDriver({ ...store, localBase: join(directory, store.localBase) })
  try {
    return await driver.getItem("theme")
  }
  finally {
    await driver.dispose?.()
  }
}
