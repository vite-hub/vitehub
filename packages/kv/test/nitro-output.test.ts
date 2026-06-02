import { readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build, createNitro, prepare } from "nitro/builder"

const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")

async function cleanupPlayground() {
  await rm(join(playgroundDir, ".output"), { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
  await rm(join(playgroundDir, ".wrangler"), { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
}

beforeAll(async () => {
  await cleanupPlayground()
})

afterAll(async () => {
  await cleanupPlayground()
})

describe("Vite playground Nitro host KV output", () => {
  it("writes kv namespace bindings when KV_NAMESPACE_ID is provided", async () => {
    const previousKvNamespaceId = process.env.KV_NAMESPACE_ID
    const previousNitroMode = process.env.VITEHUB_NITRO_MODE
    process.env.KV_NAMESPACE_ID = "kv-namespace"
    process.env.VITEHUB_NITRO_MODE = "kv"
    const nitro = await createNitro({
      preset: "cloudflare-module",
      rootDir: playgroundDir,
    })
    try {
      await prepare(nitro)
      await build(nitro)
    }
    finally {
      await nitro.close()
      if (previousKvNamespaceId === undefined) delete process.env.KV_NAMESPACE_ID
      else process.env.KV_NAMESPACE_ID = previousKvNamespaceId
      if (previousNitroMode === undefined) delete process.env.VITEHUB_NITRO_MODE
      else process.env.VITEHUB_NITRO_MODE = previousNitroMode
    }

    const wrangler = JSON.parse(await readFile(join(playgroundDir, ".output", "server", "wrangler.json"), "utf8"))
    expect(wrangler.kv_namespaces).toContainEqual({
      binding: "KV",
      id: "kv-namespace",
    })
  }, 30_000)
})
