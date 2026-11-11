// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Window } from "happy-dom"
import type { Ref } from "vue"

// The package compiles without the DOM library. The test environment installs happy-dom's document.
const { document } = globalThis as unknown as Window

type SessionState = { data: unknown, error: null, isPending: boolean, isRefetching: boolean, refetch: () => Promise<void> }

// Better Auth's session in the browser, which a test sets once the client has "loaded".
const betterAuth = vi.hoisted(() => ({ session: undefined as unknown, watched: 0 }))

vi.mock("better-auth/vue", () => ({
  createAuthClient: () => ({
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

// Each test gets new modules, because the app shares one session per client.
let Can: typeof import("../src/vue.ts").Can
let setSessionSeedResolver: typeof import("../src/vue.ts").setSessionSeedResolver
let useAbility: typeof import("../src/vue.ts").useAbility

beforeEach(async () => {
  vi.resetModules()
  ;({ Can, setSessionSeedResolver, useAbility } = await import("../src/vue.ts"))
})

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
  setSessionSeedResolver(undefined)
  betterAuth.session = undefined
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
  })

  it("renders #denied when the server read no session", async () => {
    setSessionSeedResolver(() => null)
    betterAuth.session = pendingSession()
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
