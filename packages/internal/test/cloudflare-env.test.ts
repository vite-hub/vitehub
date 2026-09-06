import { afterEach, describe, expect, it } from "vitest"

import {
  clearActiveCloudflareEnv,
  getActiveCloudflareEnv,
  getCloudflareEnv,
  resolveWaitUntil,
  runWithActiveCloudflareEnv,
  setActiveCloudflareEnv,
} from "../src/runtime/cloudflare-env.ts"

afterEach(() => clearActiveCloudflareEnv())

describe("Cloudflare environment context", () => {
  it("can read event bindings without inheriting the ambient environment", () => {
    const ambient = { name: "ambient" }
    const eventEnv = { name: "event" }
    setActiveCloudflareEnv(ambient)
    expect(getCloudflareEnv({})).toBe(ambient)
    expect(getCloudflareEnv({}, { fallback: false })).toBeUndefined()
    expect(getCloudflareEnv({ env: eventEnv }, { fallback: false })).toBe(eventEnv)
  })

  it("can prefer a host lifetime without changing default event precedence", () => {
    const owners: unknown[] = []
    const waitUntil = function (this: unknown) { owners.push(this) }
    const host = { waitUntil }
    const event = { context: { cloudflare: { context: host } }, waitUntil }
    const task = Promise.resolve()
    resolveWaitUntil(event)?.(task)
    resolveWaitUntil(event, { preferHost: true })?.(task)
    expect(owners).toEqual([event, host])
  })

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
