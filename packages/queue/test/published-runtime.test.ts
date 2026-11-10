import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const queue = await import(distEntry.href)
const resolvePackageImport = createRequire(import.meta.url).resolve

describe("published Queue error runtime", () => {
  it("does not publish a package-specific error constructor", () => {
    expect(queue).not.toHaveProperty("QueueError")
  })

  it("keeps the Cloudflare worker helper on the public root", () => {
    expect(queue.createQueueCloudflareWorker).toBeTypeOf("function")
  })
})

describe("published Queue internal runtime", () => {
  const internalRuntimeFiles = ["cloudflare-vite", "postgres-client", "state"]

  it.each(internalRuntimeFiles)("builds the internal runtime file %s that generated code imports by path", async (file) => {
    await expect(import(new URL(`../dist/internal/runtime/${file}.js`, import.meta.url).href))
      .resolves.toBeTypeOf("object")
  })

  it.each(internalRuntimeFiles)("does not export the internal runtime file %s", (file) => {
    expect(() => resolvePackageImport(`@vite-hub/queue/internal/runtime/${file}`)).toThrow(/Package subpath/)
    expect(() => resolvePackageImport(`@vite-hub/queue/runtime/${file}`)).toThrow(/Package subpath/)
  })

  it("keeps the supported hosted adapter public", () => {
    expect(resolvePackageImport("@vite-hub/queue/runtime/hosted"))
      .toBe(fileURLToPath(new URL("../dist/runtime/hosted.js", import.meta.url)))
  })
})
