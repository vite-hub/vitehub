// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"

import { appPathname, matchesPath, readLoaderOptions, runLoader, trackNavigation } from "../src/comments-overlay/loader-core.ts"
import type { LoaderEnvironment, OverlayControl } from "../src/comments-overlay/loader-core.ts"

type Listener = () => void

/** A loader environment with a page the test can move, and a fake overlay that records what it is told. */
function environment(answer: () => Promise<Response> | Response, start = "/pricing", extra: Partial<LoaderEnvironment> = {}) {
  let path = start
  const listeners = new Set<Listener>()
  const fetchMock = vi.fn(async () => answer())
  const control: OverlayControl = { destroy: vi.fn(), setActive: vi.fn() }
  const mount = vi.fn(() => control)
  const load = vi.fn(async () => ({ mount }))
  const env: LoaderEnvironment = {
    base: "/",
    // An app that explicitly opts into the marker maintains this cookie itself.
    cookie: () => "theme=dark; vitehub_session=1",
    fetch: fetchMock as never,
    load,
    overlayUrl: "/_vitehub/comments/overlay.abc.js",
    path: () => path,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...extra,
  }
  const go = async (next: string) => {
    path = next
    for (const listener of listeners) listener()
    await vi.waitFor(() => undefined)
  }
  return { control, env, fetchMock, go, listeners, load, mount }
}

const session = (value: Record<string, unknown>) => () => Response.json({ ok: true, value })
const readable = session({ canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } })
const none = { edit: false, exclude: [], paths: [], session: "always" } as const

describe("the comments loader", () => {
  it("downloads the overlay only when the session may read comments", async () => {
    const page = environment(readable, "/pricing", { nonce: "n1" })
    await runLoader(none, page.env).ready
    expect(page.fetchMock).toHaveBeenCalledOnce()
    const [url, init] = page.fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/_vitehub/rpc/__call")
    expect(JSON.parse(String(init.body))).toEqual({ input: { subject: { id: "/pricing", kind: "page" } }, operation: "comments.session" })
    expect(init.credentials).toBe("same-origin")
    expect(page.load).toHaveBeenCalledWith("/_vitehub/comments/overlay.abc.js")
    expect(page.mount).toHaveBeenCalledWith(expect.objectContaining({ active: true, base: "/", edit: false, nonce: "n1", session: { canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } } }))
  })

  it("sends the new page subject when revalidating on navigation", async () => {
    const page = environment(readable)
    const loader = runLoader(none, page.env)
    await loader.ready
    await page.go("/docs/intro")
    const [, init] = page.fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body)).input).toEqual({ subject: { id: "/docs/intro", kind: "page" } })
    loader.stop()
  })

  it("downloads nothing more for a visitor who cannot read, is not signed in, or meets a server without comments", async () => {
    const cases: Array<() => Promise<Response> | Response> = [
      session({ canRead: false, canWrite: false, user: null }),
      () => new Response("{}", { status: 401 }),
      () => Response.json({ code: "CONSOLE_ACCESS_DENIED", ok: false, status: 403 }, { status: 403 }),
      () => Response.json({ code: "INTERNAL_R0021", ok: false }, { status: 404 }),
      () => new Response("<html>not json</html>"),
      session({ canRead: "yes" }),
      () => { throw new TypeError("offline") },
    ]
    for (const answer of cases) {
      const closed = environment(answer)
      await runLoader(none, closed.env).ready
      expect(closed.load).not.toHaveBeenCalled()
      expect(closed.mount).not.toHaveBeenCalled()
    }
  })

  it("makes no request for a visitor with no session marker, and asks once the marker appears", async () => {
    let cookie = "theme=dark"
    const anonymous = environment(readable, "/pricing", { cookie: () => cookie })
    await runLoader({ ...none, session: "marker" }, anonymous.env).ready
    expect(anonymous.fetchMock).not.toHaveBeenCalled()
    expect(anonymous.load).not.toHaveBeenCalled()
    // A cleared marker, as after sign-out, is no marker.
    cookie = "vitehub_session=; theme=dark"
    await anonymous.go("/about")
    expect(anonymous.fetchMock).not.toHaveBeenCalled()
    // Another cookie that merely ends in the name is not the marker either.
    cookie = "x_vitehub_session=1"
    await anonymous.go("/contact")
    expect(anonymous.fetchMock).not.toHaveBeenCalled()
    cookie = "vitehub_session=1"
    await anonymous.go("/pricing")
    await vi.waitFor(() => expect(anonymous.mount).toHaveBeenCalledOnce())
    expect(anonymous.fetchMock).toHaveBeenCalledOnce()
  })

  it("checks authorization without a marker by default", async () => {
    const page = environment(readable, "/pricing", { cookie: () => "" })
    await runLoader(readLoaderOptions(""), page.env).ready
    expect(page.fetchMock).toHaveBeenCalledOnce()
    expect(page.mount).toHaveBeenCalledOnce()
  })

  it("tells the overlay whether the app can edit pages", async () => {
    const page = environment(readable)
    await runLoader({ ...none, edit: true }, page.env).ready
    expect(page.mount).toHaveBeenCalledWith(expect.objectContaining({ edit: true }))
  })

  it("rechecks a denied session after client-side sign-in", async () => {
    let answer = session({ canRead: false, canWrite: false, user: null })
    const refused = environment(() => answer())
    await runLoader(none, refused.env).ready
    answer = readable
    await refused.go("/about")
    await vi.waitFor(() => expect(refused.mount).toHaveBeenCalledOnce())
    expect(refused.fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(["marker", "denied"])("destroys private overlay state after %s session loss", async (loss) => {
    let cookie = "vitehub_session=1"
    let answer = readable
    const page = environment(() => answer(), "/pricing", { cookie: () => cookie })
    const loader = runLoader({ ...none, session: loss === "marker" ? "marker" : "always" }, page.env)
    await loader.ready
    cookie = ""
    answer = session({ canRead: false, canWrite: false, user: null })
    await page.go("/about")
    await vi.waitFor(() => expect(page.control.destroy).toHaveBeenCalledOnce())
    expect(page.fetchMock).toHaveBeenCalledTimes(loss === "marker" ? 1 : 2)
    loader.stop()
  })

  it("does not mount stale authorization after navigation or stop", async () => {
    let finish!: (response: Response) => void
    const page = environment(() => new Promise<Response>((resolve) => { finish = resolve }))
    const loader = runLoader(none, page.env)
    const stale = finish
    await page.go("/about")
    finish(Response.json({ ok: true, value: { canRead: false } }))
    stale(readable())
    await loader.ready
    expect(page.mount).not.toHaveBeenCalled()
    await page.go("/pricing")
    loader.stop()
    finish(readable())
    await vi.waitFor(() => expect(page.listeners.size).toBe(0))
    expect(page.mount).not.toHaveBeenCalled()
  })

  it("does not mount an overlay import that finishes after stop", async () => {
    const page = environment(readable)
    let finish!: () => void
    page.env.load = () => new Promise((resolve) => { finish = () => resolve({ mount: page.mount }) })
    const loader = runLoader(none, page.env)
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    loader.stop()
    finish()
    await loader.ready
    expect(page.mount).not.toHaveBeenCalled()
  })

  it("makes no request on a page the options leave out, and mounts lazily on the first allowed one", async () => {
    const options = { ...none, exclude: ["/admin/**"], paths: ["/docs/**", "/pricing"] }
    for (const [pathname, included] of [["/pricing", true], ["/pricing/", true], ["/docs/a/b", true], ["/docs", true], ["/admin/x", false], ["/blog", false]] as const) {
      const page = environment(readable, pathname)
      await runLoader(options, page.env).ready
      expect(page.fetchMock.mock.calls.length > 0, pathname).toBe(included)
    }
    const landing = environment(readable, "/blog")
    const loader = runLoader(options, landing.env)
    await loader.ready
    expect(landing.fetchMock).not.toHaveBeenCalled()
    // The loader still follows navigation, and the first allowed page starts it.
    expect(landing.listeners.size).toBe(1)
    await landing.go("/blog/post")
    expect(landing.fetchMock).not.toHaveBeenCalled()
    await landing.go("/docs/intro")
    await vi.waitFor(() => expect(landing.mount).toHaveBeenCalledWith(expect.objectContaining({ active: true })))
    expect(landing.fetchMock).toHaveBeenCalledOnce()
    loader.stop()
    expect(landing.listeners.size).toBe(0)
  })

  it("hides the overlay on a page the options leave out and shows it again on an allowed one", async () => {
    const page = environment(readable, "/docs/intro")
    await runLoader({ ...none, exclude: ["/docs/private"] }, page.env).ready
    await page.go("/docs/private")
    expect(page.control.destroy).toHaveBeenCalledOnce()
    await page.go("/docs/other")
    await vi.waitFor(() => expect(page.mount).toHaveBeenCalledTimes(2))
    expect(page.fetchMock).toHaveBeenCalledTimes(2)
    // A mount that starts on an excluded page is cancelled.
    const hidden = environment(readable, "/pricing")
    const loader = runLoader({ ...none, paths: ["/pricing"] }, hidden.env)
    await hidden.go("/nope")
    await loader.ready
    expect(hidden.mount).not.toHaveBeenCalled()
  })

  it("never throws into the page when the overlay fails to load", async () => {
    const broken = environment(readable)
    broken.env.load = async () => { throw new Error("chunk 404") }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(runLoader(none, broken.env).ready).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("matches globs by segment and depth, and reads its options from the URL", () => {
    expect(matchesPath("/a/b", { exclude: [], paths: ["/a/*"] })).toBe(true)
    expect(matchesPath("/a/b/c", { exclude: [], paths: ["/a/*"] })).toBe(false)
    expect(matchesPath("/a/b/c", { exclude: [], paths: ["/a/**"] })).toBe(true)
    expect(matchesPath("/a", { exclude: [], paths: ["/a/**"] })).toBe(true)
    expect(matchesPath("/a.b", { exclude: [], paths: ["/a.b"] })).toBe(true)
    expect(matchesPath("/axb", { exclude: [], paths: ["/a.b"] })).toBe(false)
    expect(matchesPath("/", none)).toBe(true)
    expect(readLoaderOptions(`?f=x&o=${encodeURIComponent(JSON.stringify({ exclude: ["/x"], paths: ["/y", 3] }))}`)).toEqual({ ...none, exclude: ["/x"], paths: ["/y"] })
    expect(readLoaderOptions("?f=x")).toEqual(none)
    expect(readLoaderOptions("?o=%7Bnot-json")).toEqual(none)
    expect(readLoaderOptions("?f=x&e=1")).toEqual({ ...none, edit: true })
    expect(readLoaderOptions("?f=x&e=1&o=%7Bnot-json").edit).toBe(true)
    expect(readLoaderOptions("?f=x&e=0").edit).toBe(false)
    expect(readLoaderOptions("?f=x&s=always").session).toBe("always")
    expect(readLoaderOptions("?f=x&s=marker").session).toBe("marker")
    expect(readLoaderOptions("?f=x&s=other").session).toBe("always")
  })

  it("takes the app base and trailing slashes off the page path", () => {
    expect(appPathname("/pricing", "/")).toBe("/pricing")
    expect(appPathname("/pricing/", "/")).toBe("/pricing")
    expect(appPathname("/", "/")).toBe("/")
    expect(appPathname("/portal/pricing", "/portal/")).toBe("/pricing")
    expect(appPathname("/portal/pricing/", "/portal/")).toBe("/pricing")
    expect(appPathname("/portal", "/portal/")).toBe("/")
    expect(appPathname("/portal/", "/portal/")).toBe("/")
    expect(appPathname("/portalx", "/portal/")).toBe("/portalx")
    expect(appPathname("/other", "/portal/")).toBe("/other")
  })
})

describe("trackNavigation", () => {
  const originals = { push: history.pushState, replace: history.replaceState }

  afterEach(() => {
    history.pushState = originals.push
    history.replaceState = originals.replace
  })

  it("calls back on pushState, replaceState, and popstate, and restores the methods", () => {
    const listener = vi.fn()
    const stop = trackNavigation(listener)
    history.pushState(null, "", "/a")
    history.replaceState(null, "", "/b")
    window.dispatchEvent(new PopStateEvent("popstate"))
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
    expect(history.pushState).toBe(originals.push)
    expect(history.replaceState).toBe(originals.replace)
    history.pushState(null, "", "/c")
    window.dispatchEvent(new PopStateEvent("popstate"))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("leaves another library's wrapper alone, and goes quiet instead", () => {
    const listener = vi.fn()
    const stop = trackNavigation(listener)
    const ours = history.pushState
    // A router wraps pushState after us.
    const wrapped = vi.fn(function wrapper(this: History, ...args: Parameters<History["pushState"]>) { return ours.apply(this, args) })
    history.pushState = wrapped as never
    stop()
    // We did not put the old method back over the router's wrapper.
    expect(history.pushState).toBe(wrapped)
    history.pushState(null, "", "/c")
    expect(wrapped).toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })
})
