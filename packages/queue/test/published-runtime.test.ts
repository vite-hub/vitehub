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
  const internalRuntimeSpecifiers = [
    "@vite-hub/queue/internal/runtime/cloudflare-vite",
    "@vite-hub/queue/internal/runtime/state",
    "@vite-hub/queue/internal/runtime/vercel-vite",
  ]

  it.each(internalRuntimeSpecifiers)("resolves internal runtime path %s from the built package", (specifier) => {
    const runtimePath = specifier.split("/").at(-1)
    expect(resolvePackageImport(specifier))
      .toBe(fileURLToPath(new URL(`../dist/internal/runtime/${runtimePath}.js`, import.meta.url)))
  })

  it.each(internalRuntimeSpecifiers)("loads internal runtime path %s from the built package", async (specifier) => {
    await expect(import(specifier))
      .resolves.toBeTypeOf("object")
  })

  it.each(internalRuntimeSpecifiers)("does not expose the old runtime path %s", (specifier) => {
    const runtimePath = specifier.split("/").at(-1)
    expect(() => resolvePackageImport(`@vite-hub/queue/runtime/${runtimePath}`))
      .toThrow(/Package subpath/)
  })

  it("keeps the supported hosted adapter public", () => {
    expect(resolvePackageImport("@vite-hub/queue/runtime/hosted"))
      .toBe(fileURLToPath(new URL("../dist/runtime/hosted.js", import.meta.url)))
  })
})
