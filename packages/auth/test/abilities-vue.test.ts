// @vitest-environment happy-dom
import { createApp, defineComponent, effectScope, h, nextTick, ref } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Window } from "happy-dom"
import type { Ref } from "vue"

// The package compiles without the DOM library. The test environment installs happy-dom's document.
const { document } = globalThis as unknown as Window

type SessionState = { data: unknown, error: null, isPending: boolean, isRefetching: boolean, refetch: () => Promise<void> }

// Better Auth's session in the browser, which a test sets once the client has "loaded".
const betterAuth = vi.hoisted(() => ({ session: undefined as unknown, watched: 0, current: null as unknown, asked: 0, askedAt: [] as unknown[] }))

vi.mock("better-auth/vue", () => ({
  createAuthClient: (options?: { basePath?: string }) => ({
    // What `/get-session` answers now.
    getSession: async () => {
      betterAuth.asked++
      betterAuth.askedAt.push(options?.basePath)
      return { data: betterAuth.current, error: null }
    },
    useSession: () => {
      betterAuth.watched++
      return betterAuth.session
    },
  }),
}))

/** Waits until the client has loaded Better Auth and follows its session. */
async function untilLoaded(watched: number): Promise<void> {
  await vi.waitFor(() => expect(betterAuth.watched).toBeGreaterThan(watched))
}
vi.mock("#vitehub/auth/abilities", () => import("./fixtures/abilities.ts"))

const { Can, Cannot, createAuthClient, setNuxtAppResolver, setNuxtErrorFactory, setSessionSeedResolver, useAbility } = await import("../src/vue.ts")
const { AbilityError } = await import("../src/ability-error.ts")

const author = { session: { id: "s1" }, user: { id: "u1", name: "Ada", emailVerified: true } }
const ownPost = { authorId: "u1", published: false }
const otherPost = { authorId: "u2", published: false }

function pendingSession(): Ref<SessionState> {
  return ref({ data: null, error: null, isPending: true, isRefetching: false, refetch: async () => {} })
}

/** Server-rendered HTML without the fragment markers of a slot. */
async function render(vnode: ReturnType<typeof h>): Promise<string> {
  return (await renderToString(vnode)).replace(/<!--[[\]]-->/g, "")
}

function canEdit(post: unknown) {
  return h(Can as never, { do: "posts.edit", with: post }, {
    default: () => h("button", "Edit"),
    denied: ({ code }: { code: string }) => h("span", `denied: ${code}`),
  })
}

afterEach(() => {
  setNuxtErrorFactory(undefined)
  setNuxtAppResolver(undefined)
  setSessionSeedResolver(undefined)
  betterAuth.session = undefined
  betterAuth.current = null
  document.body.innerHTML = ""
})

describe("<Can> during server rendering", () => {
  it("renders nothing while the session is unknown", async () => {
    betterAuth.session = pendingSession()
    expect(await render(h(defineComponent(() => () => h("div", [canEdit(ownPost)]))))).toBe("<div><!----></div>")
  })

  it("renders the content or #denied once the server read the session", async () => {
    setSessionSeedResolver(() => author)
    betterAuth.session = pendingSession()
    expect(await render(canEdit(ownPost))).toBe("<button>Edit</button>")
    expect(await render(canEdit(otherPost))).toBe("<span>denied: not-author</span>")

    setSessionSeedResolver(() => null)
    expect(await render(canEdit(ownPost))).toBe("<span>denied: signed-out</span>")
  })
})

describe("<Can> in the browser", () => {
  it("shows nothing until the session is known, then follows it", async () => {
    const session = pendingSession()
    betterAuth.session = session
    const post = ref<typeof ownPost | undefined>(undefined)
    const root = document.createElement("div")
    const watched = betterAuth.watched
    createApp(defineComponent(() => () => h(Can as never, { do: "posts.edit", with: post.value, pending: !post.value }, {
      default: () => h("button", "Edit"),
      denied: ({ code }: { code: string }) => h("span", `denied: ${code}`),
    }))).mount(root as never)

    expect(root.innerHTML).toBe("<!---->")
    // Better Auth loads in the background, then answers.
    await untilLoaded(watched)
    session.value = { ...session.value, isPending: false, data: author }
    await nextTick()
    // `pending` hides the content while the post loads.
    expect(root.innerHTML).toBe("<!---->")
    post.value = ownPost
    await nextTick()
    expect(root.innerHTML).toBe("<button>Edit</button>")

    post.value = otherPost
    await nextTick()
    expect(root.innerHTML).toBe("<span>denied: not-author</span>")

    session.value = { ...session.value, data: null }
    await nextTick()
    expect(root.innerHTML).toBe("<span>denied: signed-out</span>")
  })
})

describe("<Can> arguments", () => {
  const can = (props: Record<string, unknown>) => render(h(Can as never, props, { default: () => "yes", denied: () => "no" }))

  it("passes `args` as the list, also for default and rest parameters", async () => {
    setSessionSeedResolver(() => author)
    betterAuth.session = pendingSession()
    expect(await can({ do: "posts.move", args: ["a", "b"] })).toBe("yes")
    expect(await can({ do: "posts.move", args: ["a", "a"] })).toBe("no")
    expect(await can({ do: "posts.review", args: [otherPost] })).toBe("no")
    expect(await can({ do: "posts.review", args: [otherPost, "read"] })).toBe("yes")
    expect(await can({ do: "posts.tag", args: [] })).toBe("no")
    expect(await can({ do: "posts.tag", args: ["a", "b"] })).toBe("yes")
    expect(await can({ do: "posts.tag", args: ["a", "b", "c"] })).toBe("no")
  })

  it("answers a rule with an optional argument with or without `with`", async () => {
    setSessionSeedResolver(() => author)
    betterAuth.session = pendingSession()
    expect(await can({ do: "posts.draft" })).toBe("yes")
    expect(await can({ do: "posts.draft", with: ownPost })).toBe("yes")
    expect(await can({ do: "posts.draft", with: otherPost })).toBe("no")
  })
})

describe("useAbility()", () => {
  it("is undefined until the session is known, then answers each rule", async () => {
    const session = pendingSession()
    betterAuth.session = session
    let ability: ReturnType<typeof useAbility> | undefined
    const watched = betterAuth.watched
    createApp(defineComponent(() => {
      ability = useAbility()
      return () => null
    })).mount(document.createElement("div") as never)

    expect(ability!.ready.value).toBe(false)
    expect(ability!.can("posts.edit", ownPost)).toBeUndefined()
    await untilLoaded(watched)
    session.value = { ...session.value, isPending: false, data: author }
    await nextTick()
    expect(ability!.ready.value).toBe(true)
    expect(ability!.can("posts.edit", ownPost)).toBe(true)
    expect(ability!.can("posts.edit", otherPost)).toBe(false)
    // An optional argument does not make the answer unknown.
    expect(ability!.can("posts.draft")).toBe(true)
    expect(ability!.can("posts.review", otherPost, "read")).toBe(true)
    expect(ability!.can("posts.tag", "a", "b", "c")).toBe(false)
    expect(ability!.can("posts.create")).toBe(true)
    expect(ability!.can("admin.open")).toBe(false)
  })
})

/** `useAbility()` in a mounted component, so the session follows Better Auth. */
function mountAbility(): ReturnType<typeof useAbility> {
  let ability: ReturnType<typeof useAbility> | undefined
  createApp(defineComponent(() => {
    ability = useAbility()
    return () => null
  })).mount(document.createElement("div") as never)
  return ability!
}

describe("useAbility().cannot()", () => {
  it("is undefined until the session is known, then the opposite of can()", async () => {
    const session = pendingSession()
    betterAuth.session = session
    const watched = betterAuth.watched
    const { cannot } = mountAbility()

    expect(cannot("posts.edit", ownPost)).toBeUndefined()
    await untilLoaded(watched)
    session.value = { ...session.value, isPending: false, data: author }
    await nextTick()
    expect(cannot("posts.edit", ownPost)).toBe(false)
    expect(cannot("posts.edit", otherPost)).toBe(true)
    expect(cannot("posts.move", "a", "a")).toBe(true)
    expect(cannot("posts.draft")).toBe(false)
    expect(cannot("admin.open")).toBe(true)
  })
})

describe("useAbility().authorize()", () => {
  it("returns when the rule allows, and throws the server's refusal when it refuses", async () => {
    betterAuth.current = author
    betterAuth.session = pendingSession()
    const { authorize } = mountAbility()

    await expect(authorize("posts.edit", ownPost)).resolves.toBeUndefined()
    const refused = await authorize("posts.edit", otherPost).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(AbilityError)
    expect(refused).toMatchObject({ status: 403, statusText: "Forbidden", data: { code: "not-author", details: undefined } })
    await expect(authorize("billing.upgrade")).rejects.toMatchObject({ status: 402, data: { code: "plan-limit", details: { limit: 3 } } })
    await expect(authorize("posts.delete", otherPost)).rejects.toMatchObject({ status: 404, data: { code: "not-found" } })
    await expect(authorize("posts.move", "a", "a")).rejects.toMatchObject({ status: 403, data: { code: undefined } })

    betterAuth.current = null
    await expect(authorize("posts.edit", ownPost)).rejects.toMatchObject({ status: 401, data: { code: "signed-out" } })
    await expect(authorize("posts.read", { authorId: "u2", published: true })).resolves.toBeUndefined()
  })

  it("throws Nuxt's fatal error, with the same status and data, when the Nuxt module is installed", async () => {
    betterAuth.current = author
    betterAuth.session = pendingSession()
    const nuxtError = new Error("from createError()")
    const createError = vi.fn(() => nuxtError)
    setNuxtErrorFactory(createError)
    const { authorize } = mountAbility()

    await expect(authorize("billing.upgrade")).rejects.toBe(nuxtError)
    expect(createError).toHaveBeenCalledWith({
      status: 402,
      statusText: "Payment Required",
      message: "Payment Required.",
      data: { code: "plan-limit", details: { limit: 3 } },
      fatal: true,
    })
  })

  it("asks Better Auth in the browser, because the server's session is old after a sign-in or sign-out in the tab", async () => {
    // The server rendered the app signed out. Then the visitor signed in, and the app navigated without a reload.
    setSessionSeedResolver(() => null)
    betterAuth.session = ref({ data: author, error: null, isPending: false, isRefetching: false, refetch: async () => {} })
    betterAuth.current = author
    await expect(mountAbility().authorize("posts.edit", ownPost)).resolves.toBeUndefined()

    setSessionSeedResolver(() => author)
    betterAuth.current = null
    await expect(mountAbility().authorize("posts.edit", ownPost)).rejects.toMatchObject({ status: 401, data: { code: "signed-out" } })
  })

  it("asks the Auth endpoint of the Nuxt page guard, also with a custom basePath below app.baseURL", async () => {
    // `defineAuth({ basePath: '/auth' })` under Nuxt `app.baseURL: '/app/'`: the Nuxt plugin provides the client of the guard.
    setNuxtAppResolver(() => ({ runWithContext: run => run(), $vitehubAuthClient: createAuthClient({ basePath: "/app/auth" }) }))
    setSessionSeedResolver(() => null)
    betterAuth.session = ref({ data: author, error: null, isPending: false, isRefetching: false, refetch: async () => {} })
    betterAuth.current = author
    betterAuth.askedAt = []
    await expect(mountAbility().authorize("posts.edit", ownPost)).resolves.toBeUndefined()
    expect(betterAuth.askedAt).toEqual(["/app/auth"])
  })

  it("uses the server's session while Nuxt hydrates the page that the server rendered with it", async () => {
    setNuxtAppResolver(() => ({ runWithContext: run => run(), isHydrating: true }))
    setSessionSeedResolver(() => author)
    betterAuth.session = pendingSession()
    betterAuth.current = null
    const asked = betterAuth.asked
    await expect(mountAbility().authorize("posts.edit", ownPost)).resolves.toBeUndefined()
    expect(betterAuth.asked).toBe(asked)

    // A prerendered page has no session from the server, so it asks Better Auth.
    setSessionSeedResolver(() => undefined)
    await expect(mountAbility().authorize("posts.edit", ownPost)).rejects.toMatchObject({ status: 401 })
    expect(betterAuth.asked).toBe(asked + 1)
  })

  it("counts an unknown session as signed out during server rendering", async () => {
    betterAuth.session = pendingSession()
    const window = Object.getOwnPropertyDescriptor(globalThis, "window")!
    Reflect.deleteProperty(globalThis, "window")
    const scope = effectScope()
    try {
      const { authorize } = scope.run(() => useAbility())!
      await expect(authorize("posts.edit", ownPost)).rejects.toMatchObject({ status: 401, data: { code: "signed-out" } })
    }
    finally {
      scope.stop()
      Object.defineProperty(globalThis, "window", window)
    }
  })
})

describe("<Cannot>", () => {
  const cannot = (props: Record<string, unknown>) => render(h(Cannot as never, props, {
    default: ({ code }: { code?: string }) => h("span", `cannot: ${code}`),
  }))

  it("renders its slot with the refusal only when the rule refuses", async () => {
    betterAuth.session = pendingSession()
    expect(await cannot({ do: "posts.edit", with: otherPost })).toBe("<!---->")

    setSessionSeedResolver(() => author)
    expect(await cannot({ do: "posts.edit", with: ownPost })).toBe("<!---->")
    expect(await cannot({ do: "posts.edit", with: otherPost })).toBe("<span>cannot: not-author</span>")
    expect(await cannot({ do: "posts.edit", with: otherPost, pending: true })).toBe("<!---->")
    expect(await cannot({ do: "posts.move", args: ["a", "a"] })).toBe("<span>cannot: undefined</span>")
    expect(await cannot({ do: "posts.move", args: ["a", "b"] })).toBe("<!---->")
    expect(await cannot({ do: "posts.draft" })).toBe("<!---->")

    setSessionSeedResolver(() => null)
    expect(await cannot({ do: "posts.edit", with: ownPost })).toBe("<span>cannot: signed-out</span>")
  })

  it("passes the details of deny() to its slot", async () => {
    setSessionSeedResolver(() => author)
    betterAuth.session = pendingSession()
    const html = await render(h(Cannot as never, { do: "billing.upgrade" }, {
      default: ({ code, details }: { code: string, details: { limit: number } }) => h("span", `${code} ${details.limit}`),
    }))
    expect(html).toBe("<span>plan-limit 3</span>")
  })
})
