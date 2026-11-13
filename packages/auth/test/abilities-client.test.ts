// @vitest-environment happy-dom
import { createApp, defineComponent, h } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Window } from "happy-dom"

vi.mock("#vitehub/auth/abilities", () => import("./fixtures/abilities.ts"))

const { Can, createAuthClient, provideAuthClient, setNuxtAppResolver, setSessionSeedResolver, useAbility, useSession } = await import("../src/vue.ts")
const { document } = globalThis as unknown as Window
const author = { session: { id: "s1", expiresAt: new Date(Date.now() + 60_000).toISOString() }, user: { id: "u1", name: "Ada", email: "ada@example.com", emailVerified: true } }
const ownPost = { authorId: "u1", published: false }
const apps: ReturnType<typeof createApp>[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  setNuxtAppResolver(undefined)
  setSessionSeedResolver(undefined)
  vi.unstubAllGlobals()
})

describe("configured ability clients", () => {
  it.each(["provided", "nuxt"])("keeps the SSR answer after the %s client refreshes at its custom path", async (source) => {
    const requests: string[] = []
    let answer: typeof author | null = author
    const client = createAuthClient({
      baseURL: "http://localhost:3000",
      basePath: "/auth",
      fetchOptions: {
        customFetchImpl: async (input) => {
          const url = String(input)
          requests.push(url)
          return new Response(JSON.stringify(url.endsWith("/auth/get-session") ? answer : null), {
            status: url.endsWith("/auth/get-session") ? 200 : 404,
            headers: { "content-type": "application/json" },
          })
        },
      },
    })
    setSessionSeedResolver(() => author)
    if (source === "nuxt") setNuxtAppResolver(() => ({ runWithContext: run => run(), $vitehubAuthClient: client }))
    let ability: ReturnType<typeof useAbility> | undefined
    let explicit: ReturnType<typeof useAbility> | undefined
    let refresh: (() => Promise<void>) | undefined
    const Child = defineComponent(() => {
      ability = useAbility()
      explicit = useAbility(client)
      const state = useSession(client)
      refresh = () => state.value.refetch()
      return () => h(Can as never, { do: "posts.edit", with: ownPost }, {
        default: () => h("button", "Edit"),
        denied: ({ code }: { code: string }) => h("span", code),
      })
    })
    const app = createApp(defineComponent(() => {
      if (source === "provided") provideAuthClient(client)
      return () => h(Child)
    }))
    apps.push(app)
    const root = document.createElement("div")
    app.mount(root as never)
    expect(ability!.can("posts.edit", ownPost)).toBe(true)
    expect(root.innerHTML).toContain("Edit")

    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(ability!.can("posts.edit", ownPost)).toBe(true))
    expect(explicit!.can("posts.edit", ownPost)).toBe(true)
    expect(root.innerHTML).toContain("Edit")
    expect(requests.every(url => url.endsWith("/auth/get-session"))).toBe(true)

    // A second answer proves the hooks follow the browser client rather than retaining only the SSR seed.
    answer = null
    await refresh!()
    await vi.waitFor(() => expect(ability!.can("posts.edit", ownPost)).toBe(false))
    expect(explicit!.can("posts.edit", ownPost)).toBe(false)
    expect(root.innerHTML).toContain("signed-out")
  })
})
