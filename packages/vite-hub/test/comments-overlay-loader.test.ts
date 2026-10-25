import { describe, expect, it, vi } from "vitest"

import { matchesPath, readLoaderOptions, runLoader } from "../src/comments-overlay/loader-core.ts"
import type { LoaderEnvironment } from "../src/comments-overlay/loader-core.ts"

function environment(answer: () => Promise<Response> | Response, extra: Partial<LoaderEnvironment> = {}) {
  const fetchMock = vi.fn(async () => answer())
  const mount = vi.fn(() => "mounted")
  const load = vi.fn(async () => ({ mount }))
  const env: LoaderEnvironment = { base: "/", fetch: fetchMock as never, load, overlayUrl: "/_vitehub/comments/overlay.js?v=1", pathname: "/pricing", ...extra }
  return { env, fetchMock, load, mount }
}

const session = (value: Record<string, unknown>) => () => Response.json({ ok: true, value })
const none = { exclude: [], paths: [] }

describe("the comments loader", () => {
  it("downloads the overlay only when the session may read comments", async () => {
    const readable = environment(session({ canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } }))
    expect(await runLoader(none, readable.env)).toBe("mounted")
    expect(readable.fetchMock).toHaveBeenCalledOnce()
    const [url, init] = readable.fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/_vitehub/rpc/__call")
    expect(JSON.parse(String(init.body))).toEqual({ input: {}, operation: "comments.session" })
    expect(init.credentials).toBe("same-origin")
    expect(readable.load).toHaveBeenCalledWith("/_vitehub/comments/overlay.js?v=1")
    expect(readable.mount).toHaveBeenCalledWith({ base: "/", session: { canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } } })
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
      expect(await runLoader(none, closed.env)).toBeUndefined()
      expect(closed.load).not.toHaveBeenCalled()
      expect(closed.mount).not.toHaveBeenCalled()
    }
  })

  it("makes no request at all on a page the options leave out", async () => {
    const options = { exclude: ["/admin/**"], paths: ["/docs/**", "/pricing"] }
    for (const [pathname, included] of [["/pricing", true], ["/pricing/", true], ["/docs/a/b", true], ["/docs", true], ["/admin/x", false], ["/blog", false]] as const) {
      const page = environment(session({ canRead: true, canWrite: false, user: null }), { pathname })
      await runLoader(options, page.env)
      expect(page.fetchMock.mock.calls.length > 0, pathname).toBe(included)
    }
  })

  it("never throws into the page when the overlay fails to load", async () => {
    const broken = environment(session({ canRead: true, canWrite: true, user: null }))
    broken.env.load = async () => { throw new Error("chunk 404") }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(runLoader(none, broken.env)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("matches globs by segment and depth, and reads its options from the URL", () => {
    expect(matchesPath("/a/b", { exclude: [], paths: ["/a/*"] })).toBe(true)
    expect(matchesPath("/a/b/c", { exclude: [], paths: ["/a/*"] })).toBe(false)
    expect(matchesPath("/a/b/c", { exclude: [], paths: ["/a/**"] })).toBe(true)
    expect(matchesPath("/a.b", { exclude: [], paths: ["/a.b"] })).toBe(true)
    expect(matchesPath("/axb", { exclude: [], paths: ["/a.b"] })).toBe(false)
    expect(matchesPath("/", none)).toBe(true)
    expect(readLoaderOptions(`?v=1&o=${encodeURIComponent(JSON.stringify({ exclude: ["/x"], paths: ["/y", 3] }))}`)).toEqual({ exclude: ["/x"], paths: ["/y"] })
    expect(readLoaderOptions("?v=1")).toEqual(none)
    expect(readLoaderOptions("?o=%7Bnot-json")).toEqual(none)
  })
})
