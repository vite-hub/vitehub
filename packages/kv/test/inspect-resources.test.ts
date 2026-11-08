import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { inspectKVResources } from "../src/inspect.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("KV resource inspection", () => {
  it("shows where each namespace id comes from", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-kv-resources-"))
    directories.push(rootDir)
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub", "provision.json"), JSON.stringify({ cloudflare: { kv: { cache: "ns-state" } } }))
    const options = {
      stores: {
        cache: { binding: "CACHE", driver: "cloudflare-kv-binding", namespaceName: "app-cache" },
        default: { binding: "KV", driver: "cloudflare-kv-binding" },
        local: { driver: "fs-lite" },
        pinned: { binding: "PINNED", driver: "cloudflare-kv-binding", namespaceId: "ns-config" },
      },
    } as const

    const resources = inspectKVResources(options, rootDir, { KV_NAMESPACE_ID: "ns-env" })

    expect(Object.fromEntries(resources.map(({ binding, definition, env, id, source }) => [definition, { binding, env, id, source }]))).toEqual({
      cache: { binding: "CACHE", env: "KV_NAMESPACE_ID", id: "ns-env", source: "env" },
      default: { binding: "KV", env: "KV_NAMESPACE_ID", id: "ns-env", source: "env" },
      pinned: { binding: "PINNED", env: undefined, id: "ns-config", source: "config" },
    })
    expect(inspectKVResources(options, rootDir, {}).map(({ definition, id, source }) => ({ definition, id, source }))).toEqual([
      { definition: "default", id: undefined, source: undefined },
      { definition: "cache", id: "ns-state", source: "provision-state" },
      { definition: "pinned", id: "ns-config", source: "config" },
    ])
  })
})
