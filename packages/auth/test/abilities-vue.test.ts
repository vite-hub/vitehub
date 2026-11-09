// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"

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

const { Can, setSessionSeedResolver, useAbility } = await import("../src/vue.ts")

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
    createApp(defineComponent(() => () => canEdit(post.value))).mount(root as never)

    expect(root.innerHTML).toBe("<!---->")
    // Better Auth loads in the background, then answers.
    await untilLoaded(watched)
    session.value = { ...session.value, isPending: false, data: author }
    await nextTick()
    // The argument is still loading.
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

  it("passes an array to a rule with more than one argument", async () => {
    setSessionSeedResolver(() => author)
    betterAuth.session = pendingSession()
    const move = (from: string, to: string) => render(h(Can as never, { do: "posts.move", with: [from, to] }, { default: () => "move" }))
    expect(await move("a", "b")).toBe("move")
    expect(await move("a", "a")).toBe("<!---->")
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
    expect(ability!.can("posts.edit", undefined)).toBeUndefined()
    expect(ability!.can("posts.create")).toBe(true)
    expect(ability!.can("admin.open")).toBe(false)
  })
})
