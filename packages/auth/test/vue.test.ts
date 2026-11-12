import { effectScope, nextTick, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

// Better Auth's client, recorded: which options it was created with, and every call it answered.
const betterAuth = vi.hoisted(() => ({ created: [] as unknown[], calls: [] as unknown[][], failures: 0, session: undefined as unknown }))

vi.mock("better-auth/vue", () => ({
  createAuthClient(options: unknown) {
    if (betterAuth.failures > 0) {
      betterAuth.failures--
      throw new Error("transient Better Auth load failure")
    }
    betterAuth.created.push(options)
    return {
      signIn: { social: async (input: unknown) => { betterAuth.calls.push(["signIn.social", input]); return { data: input } } },
      signOut: async () => { betterAuth.calls.push(["signOut"]); return { data: true } },
      useSession: () => betterAuth.session,
      $store: { name: "store" },
    }
  },
}))

const { authClient, createAuthClient, loadAuthClient, setNuxtAppResolver, setSessionSeedResolver, useAuthClient, useSession, useUserSession } = await import("../src/vue.ts")

afterEach(() => {
  setNuxtAppResolver(undefined)
  setSessionSeedResolver(undefined)
  betterAuth.created.length = 0
  betterAuth.calls.length = 0
  vi.unstubAllGlobals()
})

describe("Vue Auth composables", () => {
  it("projects the shared client", () => {
    expect(useAuthClient() === authClient).toBe(true)
    expect(useSession()).toBeDefined()
  })

  it("uses Nuxt's configured client in both default session composables", async () => {
    vi.stubGlobal("window", {})
    const client = createAuthClient({ basePath: "/custom-auth" })
    setNuxtAppResolver(() => ({ runWithContext: run => run(), $vitehubAuthClient: client }))
    const real = ref({ data: null, error: null, isPending: true, isRefetching: false, refetch: async () => {} })
    betterAuth.session = real
    const state = useSession()
    const session = useUserSession()

    expect(useAuthClient()).toBe(client)
    await vi.waitFor(() => expect(betterAuth.created).toEqual([{ basePath: "/custom-auth" }]))
    real.value = { ...real.value, isPending: false, data: { session: { id: "s" }, user: { id: "u" } } as never }
    await nextTick()
    expect(state.value.data?.user.id).toBe("u")
    expect(session.user.value?.id).toBe("u")
  })

  it("creates Better Auth's client on the first call, not before", async () => {
    const client = createAuthClient({ basePath: "/auth" })
    useUserSession(client)
    expect(betterAuth.created).toEqual([])

    await expect(client.signIn.social({ provider: "github" })).resolves.toEqual({ data: { provider: "github" } })
    await client.signOut()
    expect(betterAuth.created).toEqual([{ basePath: "/auth" }])
    expect(betterAuth.calls).toEqual([["signIn.social", { provider: "github" }], ["signOut"]])
  })

  it("loads Better Auth's client again on the next call after a failed load", async () => {
    betterAuth.failures = 1
    const client = createAuthClient()

    await expect(client.signOut()).rejects.toThrow("transient Better Auth load failure")
    await expect(client.signOut()).resolves.toEqual({ data: true })
    expect(betterAuth.created).toHaveLength(1)
  })

  it("is not a thenable, so awaiting it gives the client back", async () => {
    const client = createAuthClient()
    expect(await Promise.resolve(client)).toBe(client)
    expect(betterAuth.created).toEqual([])
  })

  it("keeps the session pending during server rendering, without loading Better Auth", () => {
    const session = useUserSession(createAuthClient())
    expect(session.pending.value).toBe(true)
    expect(session.loggedIn.value).toBe(false)
    expect(betterAuth.created).toEqual([])
  })

  it("follows Better Auth's session in the browser once it has loaded, within the caller's scope", async () => {
    vi.stubGlobal("window", {})
    const real = ref({ data: null, error: null, isPending: true, isRefetching: false, refetch: async () => {} })
    betterAuth.session = real
    const scope = effectScope()
    const session = scope.run(() => useUserSession(createAuthClient()))!
    expect(session.ready.value).toBe(false)

    await vi.waitFor(() => expect(betterAuth.created).toHaveLength(1))
    real.value = { ...real.value, isPending: false, data: { session: { id: "s" }, user: { id: "u" } } as never }
    await nextTick()
    expect(session.loggedIn.value).toBe(true)
    expect(session.user.value).toEqual({ id: "u" })

    scope.stop()
    real.value = { ...real.value, data: null }
    await nextTick()
    expect(session.loggedIn.value).toBe(true)
  })

  it("starts settled with the session that the server read, without loading Better Auth", () => {
    setSessionSeedResolver(() => ({ session: { id: "s" }, user: { id: "u", name: "Ada" } }))
    const session = useUserSession(createAuthClient())
    expect(session.ready.value).toBe(true)
    expect(session.loggedIn.value).toBe(true)
    expect(session.user.value).toEqual({ id: "u", name: "Ada" })
    expect(betterAuth.created).toEqual([])
    setSessionSeedResolver(() => null)
    const signedOut = useUserSession(createAuthClient())
    expect(signedOut.ready.value).toBe(true)
    expect(signedOut.loggedIn.value).toBe(false)
  })

  it("keeps the server's session in the browser until Better Auth has its own", async () => {
    vi.stubGlobal("window", {})
    setSessionSeedResolver(() => ({ session: { id: "s" }, user: { id: "u" } }))
    const real = ref({ data: null, error: null, isPending: true, isRefetching: false, refetch: async () => {} })
    betterAuth.session = real
    const session = useUserSession(createAuthClient())
    await vi.waitFor(() => expect(betterAuth.created).toHaveLength(1))
    await nextTick()
    // Better Auth starts pending with no data. The page must not flash signed out.
    expect(session.loggedIn.value).toBe(true)
    real.value = { ...real.value, isPending: false, data: null }
    await nextTick()
    expect(session.loggedIn.value).toBe(false)
  })

  it("gives Better Auth's own client for members that are not calls", async () => {
    const client = createAuthClient()
    const loaded = await loadAuthClient(client)
    expect(Reflect.get(loaded, "$store")).toEqual({ name: "store" })
  })

  it("restores Nuxt context for delayed useFetch hooks without a Vue instance", async () => {
    const runWithContext = vi.fn(<T>(run: () => T): T => run())
    setNuxtAppResolver(() => ({ runWithContext }) as never)
    const client = createAuthClient()
    const useFetch = () => undefined
    await client.useSession(useFetch as never)
    expect(runWithContext).toHaveBeenCalledOnce()
    setNuxtAppResolver(undefined)
  })
})
