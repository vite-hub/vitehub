import { afterEach, describe, expect, it } from "vitest"

import {
  clearActiveCloudflareEnv,
  getActiveCloudflareEnv,
  runWithActiveCloudflareEnv,
  setActiveCloudflareEnv,
} from "../src/runtime/cloudflare-env.ts"

afterEach(() => clearActiveCloudflareEnv())

describe("Cloudflare environment context", () => {
  it("shares request bindings across bundled runtime copies", async () => {
    const first = await import("../src/runtime/cloudflare-env.ts?copy=first")
    const second = await import("../src/runtime/cloudflare-env.ts?copy=second")

    await first.runWithActiveCloudflareEnv({ BLOB: "bucket" }, async () => {
      await Promise.resolve()
      expect(second.getActiveCloudflareBinding("BLOB")).toBe("bucket")
    })
  })

  it("restores the fallback environment after synchronous request context", () => {
    const fallback = { name: "fallback" }
    const request = { name: "request" }
    setActiveCloudflareEnv(fallback)

    expect(runWithActiveCloudflareEnv(request, getActiveCloudflareEnv)).toBe(request)
    expect(getActiveCloudflareEnv()).toBe(fallback)
  })

  it("masks the fallback environment in an explicit empty request context", () => {
    const fallback = { name: "fallback" }
    setActiveCloudflareEnv(fallback)

    expect(runWithActiveCloudflareEnv(undefined, getActiveCloudflareEnv)).toBeUndefined()
    expect(getActiveCloudflareEnv()).toBe(fallback)
  })

  it("restores the fallback environment after asynchronous request context", async () => {
    const fallback = { name: "fallback" }
    const request = { name: "request" }
    setActiveCloudflareEnv(fallback)

    await expect(runWithActiveCloudflareEnv(request, async () => {
      await Promise.resolve()
      return getActiveCloudflareEnv()
    })).resolves.toBe(request)
    expect(getActiveCloudflareEnv()).toBe(fallback)
  })
})
