import { effectScope, nextTick, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

// Better Auth's client, recorded: which options it was created with, and every call it answered.
const betterAuth = vi.hoisted(() => ({ created: [] as unknown[], calls: [] as unknown[][], session: undefined as unknown, subscriptions: 0 }))

vi.mock("better-auth/vue", () => ({
  createAuthClient(options: unknown) {
    betterAuth.created.push(options)
    return {
      signIn: { social: async (input: unknown) => { betterAuth.calls.push(["signIn.social", input]); return { data: input } } },
      signOut: async () => { betterAuth.calls.push(["signOut"]); return { data: true } },
      useSession: () => {
        betterAuth.subscriptions++
        return betterAuth.session
      },
      $store: { name: "store" },
    }
  },
}))

const { authClient, createAuthClient, loadAuthClient, setNuxtAppResolver, setSessionSeedResolver, useAuthClient, useSession, useUserSession } = await import("../src/vue.ts")

afterEach(() => {
  setSessionSeedResolver(undefined)
  setNuxtAppResolver(undefined)
  betterAuth.created.length = 0
  betterAuth.calls.length = 0
  betterAuth.subscriptions = 0
  vi.unstubAllGlobals()
})

describe("Vue Auth composables", () => {
  it("projects the shared client", () => {
    expect(useAuthClient() === authClient).toBe(true)
    expect(useSession()).toBeDefined()
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

  it("follows Better Auth's session in the browser once it has loaded, after the first caller's scope stops", async () => {
    vi.stubGlobal("window", {})
    const real = ref({ data: null, error: null, isPending: true, isRefetching: false, refetch: async () => {} })
    betterAuth.session = real
    const client = createAuthClient()
    const scope = effectScope()
    const session = scope.run(() => useUserSession(client))!
    expect(session.ready.value).toBe(false)

    await vi.waitFor(() => expect(betterAuth.created).toHaveLength(1))
    real.value = { ...real.value, isPending: false, data: { session: { id: "s" }, user: { id: "u" } } as never }
    await nextTick()
    expect(session.loggedIn.value).toBe(true)
    expect(session.user.value).toEqual({ id: "u" })

    // The state belongs to the app, not to the first component, so the next component still sees sign-out.
    scope.stop()
    real.value = { ...real.value, data: null }
    await nextTick()
    expect(useUserSession(client).loggedIn.value).toBe(false)
  })

  it("shares one state and one Better Auth subscription between all components of the app", async () => {
    vi.stubGlobal("window", {})
    betterAuth.session = ref({ data: null, error: null, isPending: true, isRefetching: false, refetch: async () => {} })
    const client = createAuthClient()
    const sessions = Array.from({ length: 100 }, () => effectScope().run(() => useUserSession(client))!)

    await vi.waitFor(() => expect(betterAuth.created).toHaveLength(1))
    await nextTick()
    expect(betterAuth.subscriptions).toBe(1)
    expect(new Set(sessions).size).toBe(1)
    expect(useSession(client)).toBe(useSession(client))
    expect(client.useSession()).toBe(useSession(client))
  })

  it("reads once for callers at the same time and returns the session from refresh()", async () => {
    vi.stubGlobal("window", {})
    const signedIn = { session: { id: "s" }, user: { id: "u" } }
    const real = ref({ data: null as unknown, error: null, isPending: true, isRefetching: false, refetch: async () => {} })
    const refetch = vi.fn(async () => {
      await Promise.resolve()
      real.value = { ...real.value, isPending: false, data: signedIn }
    })
    real.value.refetch = refetch
    betterAuth.session = real
    const session = useUserSession(createAuthClient())

    await expect(Promise.all([session.refresh(), session.refresh()])).resolves.toEqual([signedIn, signedIn])
    expect(refetch).toHaveBeenCalledOnce()
    expect(session.user.value).toEqual({ id: "u" })
  })

  it("returns the answer of a later Better Auth read that cancelled the read of refresh()", async () => {
    vi.stubGlobal("window", {})
    const signedIn = { session: { id: "s" }, user: { id: "u" } }
    const real = ref({ data: null as unknown, error: null, isPending: false, isRefetching: false, refetch: async () => {} })
    // Better Auth cancels a read when it starts another one, such as after a sign-in. The cancelled read resolves
    // without an answer while the later read is still running.
    real.value.refetch = async () => {
      real.value = { ...real.value, isRefetching: true }
      await Promise.resolve()
    }
    betterAuth.session = real
    const session = useUserSession(createAuthClient())
    let answer: unknown = "waiting"
    void session.refresh().then((value) => { answer = value })

    await vi.waitFor(() => expect(real.value.isRefetching).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(answer).toBe("waiting")
    real.value = { ...real.value, isRefetching: false, data: signedIn }
    await vi.waitFor(() => expect(answer).toEqual(signedIn))
  })

  it("returns the request's session from refresh() on the server without loading Better Auth", async () => {
    const request = { runWithContext: <T>(run: () => T): T => run() }
    setNuxtAppResolver(() => request)
    setSessionSeedResolver(() => ({ session: { id: "s" }, user: { id: "u" } }))
    const session = useUserSession(createAuthClient())

    await expect(session.refresh()).resolves.toEqual({ session: { id: "s" }, user: { id: "u" } })
    expect(betterAuth.created).toEqual([])
  })

  it("shares the server's read in flight between callers, and keeps each request apart", async () => {
    const signedIn = { session: { id: "s" }, user: { id: "u" } }
    const read = vi.fn(async () => signedIn)
    const first = { runWithContext: <T>(run: () => T): T => run() }
    let request = first
    setNuxtAppResolver(() => request)
    setSessionSeedResolver(read)
    const client = createAuthClient()
    const { refresh } = useUserSession(client)

    await expect(Promise.all([refresh(), useUserSession(client).refresh()])).resolves.toEqual([signedIn, signedIn])
    expect(read).toHaveBeenCalledOnce()
    expect(useUserSession(client).user.value).toEqual({ id: "u" })

    request = { runWithContext: <T>(run: () => T): T => run() }
    setSessionSeedResolver(() => null)
    expect(useUserSession(client).loggedIn.value).toBe(false)
    expect(betterAuth.created).toEqual([])
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
