import { effectScope, nextTick, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

// Better Auth's client, recorded: which options it was created with, and every call it answered.
const betterAuth = vi.hoisted(() => ({ created: [] as unknown[], calls: [] as unknown[][], session: undefined as unknown }))

vi.mock("better-auth/vue", () => ({
  createAuthClient(options: unknown) {
    betterAuth.created.push(options)
    return {
      signIn: { social: async (input: unknown) => { betterAuth.calls.push(["signIn.social", input]); return { data: input } } },
      signOut: async () => { betterAuth.calls.push(["signOut"]); return { data: true } },
      useSession: () => betterAuth.session,
      $store: { name: "store" },
    }
  },
}))

const { authClient, createAuthClient, loadAuthClient, setNuxtAppResolver, useAuthClient, useSession, useSignIn, useSignUp, useUserSession } = await import("../src/vue.ts")

afterEach(() => {
  betterAuth.created.length = 0
  betterAuth.calls.length = 0
  vi.unstubAllGlobals()
})

describe("Vue Auth composables", () => {
  it("projects the shared client", () => {
    expect(useAuthClient() === authClient).toBe(true)
    expect(useSession()).toBeDefined()
    expect(typeof useSignIn()).toBe("function")
    expect(typeof useSignUp()).toBe("function")
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
