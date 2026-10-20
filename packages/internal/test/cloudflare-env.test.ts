import { afterEach, describe, expect, it } from "vitest"

import {
  clearActiveCloudflareEnv,
  getActiveCloudflareBinding,
  getActiveCloudflareEnv,
  getCloudflareEnv,
  resolveWaitUntil,
  runWithActiveCloudflareEnv,
  setActiveCloudflareEnv,
} from "../src/runtime/cloudflare-env.ts"

afterEach(() => clearActiveCloudflareEnv())

describe("Cloudflare environment context", () => {
  it("does not expose inherited environment bindings", () => {
    const env = Object.create({ BUCKET: "inherited-bucket" }) as Record<string, unknown>
    setActiveCloudflareEnv(env)

    expect(getActiveCloudflareEnv()).toBe(env)
    expect(getActiveCloudflareBinding("BUCKET")).toBeUndefined()
  })

  it("keeps the host bindings when the env reads globalThis.__env__", () => {
    // The shape of unenv's env proxy, which Nitro's Cloudflare dev server exports as `cloudflare:workers` env.
    const scope = globalThis as { __env__?: Record<PropertyKey, unknown> }
    const workersEnv = new Proxy({}, {
      get: (_, key) => scope.__env__?.[key],
      has: (_, key) => Boolean(scope.__env__ && key in scope.__env__),
      ownKeys: () => Reflect.ownKeys(scope.__env__ ?? {}),
      getOwnPropertyDescriptor: (_, key) => scope.__env__ && key in scope.__env__
        ? { configurable: true, enumerable: true, value: scope.__env__[key], writable: true }
        : undefined,
    }) as Record<string, unknown>
    const bindings = { BUCKET: "dev-bucket" }
    scope.__env__ = bindings

    // Generated plugins may run in any order, and each installs the module env.
    setActiveCloudflareEnv(workersEnv)
    setActiveCloudflareEnv(workersEnv)

    expect(scope.__env__).toBe(bindings)
    expect({ ...workersEnv }).toEqual({ BUCKET: "dev-bucket" })
    expect(getActiveCloudflareBinding("BUCKET")).toBe("dev-bucket")

    const requestEnv = { BUCKET: "request-bucket" }
    setActiveCloudflareEnv(requestEnv)
    expect(scope.__env__).toBe(requestEnv)
  })

  it("clears the installed environment and its bindings", async () => {
    setActiveCloudflareEnv({ BUCKET: "old-bucket" })

    clearActiveCloudflareEnv()

    expect(getActiveCloudflareEnv()).toBeUndefined()
    expect(getActiveCloudflareBinding("BUCKET")).toBeUndefined()
    await Promise.resolve()
    expect(getCloudflareEnv({})).toBeUndefined()
  })

  it("clears only the current request context without disabling another request", async () => {
    let release: () => void = () => {}
    const waiting = new Promise<void>(resolve => { release = resolve })
    const otherRequest = runWithActiveCloudflareEnv({ BUCKET: "other-bucket" }, async () => {
      await waiting
      expect(getActiveCloudflareBinding("BUCKET")).toBe("other-bucket")
    })

    try {
      runWithActiveCloudflareEnv({ BUCKET: "cleared-bucket" }, () => {
        clearActiveCloudflareEnv()
        expect(getActiveCloudflareBinding("BUCKET")).toBeUndefined()
      })
    }
    finally {
      release()
      await otherRequest
    }
  })

  it("does not retain a handler environment after nested cleanup", async () => {
    const outer = { BUCKET: "outer-bucket" }
    const handler = { BUCKET: "handler-bucket" }
    setActiveCloudflareEnv(outer)

    await runWithActiveCloudflareEnv(handler, async () => {
      clearActiveCloudflareEnv()
      expect(getActiveCloudflareBinding("BUCKET")).toBeUndefined()
    })

    expect(getActiveCloudflareBinding("BUCKET")).toBe("outer-bucket")
  })

  it("can read event bindings without inheriting the ambient environment", () => {
    const ambient = { name: "ambient" }
    const eventEnv = { name: "event" }
    setActiveCloudflareEnv(ambient)
    expect(getCloudflareEnv({})).toBe(ambient)
    expect(getCloudflareEnv({}, { fallback: false })).toBeUndefined()
    expect(getCloudflareEnv({ env: eventEnv }, { fallback: false })).toBe(eventEnv)
  })

  it("does not read inherited event environment carriers", () => {
    const eventEnv = { name: "inherited" }
    const event = Object.create({ env: eventEnv }) as object

    expect(getCloudflareEnv(event, { fallback: false })).toBeUndefined()
  })

  it("does not read inherited event lifetime carriers", () => {
    const waitUntil = () => {}
    const event = Object.create({ waitUntil }) as object

    expect(resolveWaitUntil(event)).toBeUndefined()
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
