import { describe, expect, it, vi } from "vitest"

const loaded = vi.hoisted(() => new Set<string>())

vi.mock("better-auth", () => {
  loaded.add("better-auth")
  return {}
})
vi.mock("better-auth/api", () => {
  loaded.add("better-auth/api")
  return {}
})
vi.mock("better-auth/cookies", () => {
  loaded.add("better-auth/cookies")
  return {}
})

const { createLazyAuthAccessHandler } = await import("../src/runtime/server.ts")

describe("Auth startup runtime", () => {
  it("loads the Auth server only for a request that an access route matches", async () => {
    const check = vi.fn(async () => new Response(null, { status: 401 }))
    const load = vi.fn(async () => ({ createAuthAccessHandler: () => check }))
    const handler = createLazyAuthAccessHandler([{ route: "/private/**", authorize: true }], load)

    await expect(handler(new Request("https://app.example/public"))).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()

    await expect(handler(new Request("https://app.example/private/a"))).resolves.toMatchObject({ status: 401 })
    await expect(handler(new Request("https://app.example/private/b"))).resolves.toMatchObject({ status: 401 })
    expect(load).toHaveBeenCalledOnce()
    expect(check).toHaveBeenCalledTimes(2)
    expect([...loaded]).toEqual([])
  })

  it("loads the Auth server again after a failed load", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValue({ createAuthAccessHandler: () => async () => undefined })
    const handler = createLazyAuthAccessHandler([{ route: "/private" }], load)

    await expect(handler(new Request("https://app.example/private"))).rejects.toThrow("load failed")
    await expect(handler(new Request("https://app.example/private"))).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
