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
  const control: OverlayControl = { setActive: vi.fn() }
  const mount = vi.fn(() => control)
  const load = vi.fn(async () => ({ mount }))
  const env: LoaderEnvironment = {
    base: "/",
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
const none = { exclude: [], paths: [] }

describe("the comments loader", () => {
  it("downloads the overlay only when the session may read comments", async () => {
    const page = environment(readable, "/pricing", { nonce: "n1" })
    await runLoader(none, page.env).ready
    expect(page.fetchMock).toHaveBeenCalledOnce()
    const [url, init] = page.fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/_vitehub/rpc/__call")
    expect(JSON.parse(String(init.body))).toEqual({ input: {}, operation: "comments.session" })
    expect(init.credentials).toBe("same-origin")
    expect(page.load).toHaveBeenCalledWith("/_vitehub/comments/overlay.abc.js")
    expect(page.mount).toHaveBeenCalledWith(expect.objectContaining({ active: true, base: "/", nonce: "n1", session: { canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } } }))
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

  it("asks once per page load, also after a no, and not again on navigation", async () => {
    const refused = environment(session({ canRead: false, canWrite: false, user: null }))
    await runLoader(none, refused.env).ready
    await refused.go("/about")
    await refused.go("/")
    expect(refused.fetchMock).toHaveBeenCalledOnce()
  })

  it("makes no request on a page the options leave out, and mounts lazily on the first allowed one", async () => {
    const options = { exclude: ["/admin/**"], paths: ["/docs/**", "/pricing"] }
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
    await runLoader({ exclude: ["/docs/private"], paths: [] }, page.env).ready
    await page.go("/docs/private")
    expect(page.control.setActive).toHaveBeenLastCalledWith(false)
    await page.go("/docs/other")
    expect(page.control.setActive).toHaveBeenLastCalledWith(true)
    expect(page.fetchMock).toHaveBeenCalledOnce()
    // A mount that starts on an excluded page starts hidden.
    const hidden = environment(readable, "/pricing")
    const loader = runLoader({ exclude: [], paths: ["/pricing"] }, hidden.env)
    await hidden.go("/nope")
    await loader.ready
    // The page moved on while the session was on its way: the overlay mounts already hidden.
    expect(hidden.mount).toHaveBeenCalledWith(expect.objectContaining({ active: false }))
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
    expect(readLoaderOptions(`?f=x&o=${encodeURIComponent(JSON.stringify({ exclude: ["/x"], paths: ["/y", 3] }))}`)).toEqual({ exclude: ["/x"], paths: ["/y"] })
    expect(readLoaderOptions("?f=x")).toEqual(none)
    expect(readLoaderOptions("?o=%7Bnot-json")).toEqual(none)
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
