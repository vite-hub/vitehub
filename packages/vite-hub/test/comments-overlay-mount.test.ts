// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/comments-overlay/overlay.css?inline", () => ({ default: ":root { --x: 1 } [data-slot='comment-layer'] { color: red }" }))

import { appPathname, trackNavigation } from "../src/comments-overlay/loader-core.ts"
import { appTheme, mount } from "../src/comments-overlay/overlay.ts"
import type { OverlaySession } from "../src/comments-overlay/loader-core.ts"
import type { OverlayHandle } from "../src/comments-overlay/overlay.ts"

const calls: Array<{ input: unknown, operation: string }> = []
let resolved: { collection: string, id: string } | undefined
const handles: OverlayHandle[] = []

beforeEach(() => {
  calls.length = 0
  resolved = undefined
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: unknown, operation: string }
    calls.push(body)
    if (body.operation === "content.resolve") return resolved ? Response.json({ ok: true, value: resolved }) : Response.json({ ok: false, code: "INTERNAL_R0021" }, { status: 404 })
    return Response.json({ ok: true, value: [] })
  }))
  history.replaceState(null, "", "/pricing")
})

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy()
  vi.unstubAllGlobals()
})

/** Mounts like the loader does: it supplies the page path, the navigation feed, and whether the page is allowed. */
async function mounted(session: OverlaySession = { canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } }, base = "/", active = true) {
  const stops: Array<() => void> = []
  const handle = mount({
    active,
    base,
    path: () => appPathname(location.pathname, base),
    session,
    subscribe: (listener) => {
      const stop = trackNavigation(listener)
      stops.push(stop)
      return stop
    },
  })
  handles.push(handle)
  if (active) await vi.waitFor(() => expect(handle.host.shadowRoot!.querySelector("[data-slot='comment-toolbar']")).not.toBeNull())
  return handle
}

describe("the comments overlay", () => {
  it("mounts the comment parts into a shadow root on a host that carries data-comments-ui", async () => {
    const { host } = await mounted()
    expect(host.isConnected).toBe(true)
    expect(host.hasAttribute("data-comments-ui")).toBe(true)
    expect(host.shadowRoot).not.toBeNull()
    // The parts live in the shadow root, not in the page, and the stylesheet comes with them with :root turned into :host.
    expect(document.body.querySelector("[data-slot='comment-toolbar']")).toBeNull()
    const style = host.shadowRoot!.querySelector("style")?.textContent ?? ""
    const adopted = (host.shadowRoot as unknown as { adoptedStyleSheets?: unknown[] }).adoptedStyleSheets?.length ?? 0
    expect(style.includes(":host { --x: 1 }") || adopted > 0).toBe(true)
    expect(host.shadowRoot!.querySelector("[data-slot='comment-toolbar-mode']")).not.toBeNull()
    expect(host.shadowRoot!.querySelector("[data-slot='comment-toolbar-edit']")).toBeNull()
  })

  it("lists the threads of the current page and follows client-side navigation", async () => {
    await mounted()
    await vi.waitFor(() => expect(calls.some(call => call.operation === "comments.list")).toBe(true))
    const lists = () => calls.filter(call => call.operation === "comments.list").map(call => JSON.stringify(call.input))
    expect(lists().at(-1)).toContain("/pricing")
    history.pushState(null, "", "/about?x=1")
    await vi.waitFor(() => expect(lists().at(-1)).toContain("/about"))
    history.replaceState(null, "", "/contact")
    await vi.waitFor(() => expect(lists().at(-1)).toContain("/contact"))
    window.dispatchEvent(new PopStateEvent("popstate"))
  })

  it("strips the app base from the subject", async () => {
    history.replaceState(null, "", "/portal/pricing")
    await mounted(undefined, "/portal/")
    await vi.waitFor(() => expect(calls.some(call => call.operation === "comments.list")).toBe(true))
    expect(JSON.stringify(calls.find(call => call.operation === "comments.list")!.input)).toContain("\"/pricing\"")
    expect(JSON.stringify(calls.find(call => call.operation === "comments.list")!.input)).not.toContain("portal")
  })

  it("links the rows of the list with the app base, as navigation does", async () => {
    const thread = {
      anchor: { kind: "page" },
      author: { id: "ana", name: "Ana" },
      createdAt: 1,
      id: "thread_1",
      messages: [{ attachments: [], author: { id: "ana", name: "Ana" }, body: "Too small.", createdAt: 1, id: "m1", mentions: [], threadId: "thread_1" }],
      n: 1,
      scope: "site",
      status: "open",
      subject: { id: "/pricing", kind: "page" },
      updatedAt: 1,
    }
    for (const [base, path, href] of [["/portal/", "/portal/pricing", "/portal/pricing?comment=1"], ["/", "/pricing", "/pricing?comment=1"]] as const) {
      history.replaceState(null, "", path)
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { operation: string }
        return Response.json({ ok: true, value: body.operation === "comments.list" ? [thread] : null })
      }))
      const { host } = await mounted(undefined, base)
      await vi.waitFor(() => expect(host.shadowRoot!.querySelector("[data-slot='comment-toolbar-list']")).not.toBeNull())
      ;(host.shadowRoot!.querySelector("[data-slot='comment-toolbar-list']") as HTMLButtonElement).click()
      await vi.waitFor(() => expect(host.shadowRoot!.querySelector("a[data-slot='comment-list-item']")).not.toBeNull())
      expect(host.shadowRoot!.querySelector("a[data-slot='comment-list-item']")!.getAttribute("href")).toBe(href)
    }
  })

  it("shows Edit only when content.resolve finds a document, and follows the page", async () => {
    resolved = { collection: "posts", id: "hello world" }
    const { host } = await mounted()
    await vi.waitFor(() => expect(host.shadowRoot!.querySelector("[data-slot='comment-toolbar-edit']")).not.toBeNull())
    const link = host.shadowRoot!.querySelector("a[data-slot='comment-toolbar-edit']") as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/_vitehub/content/posts/hello%20world")
    expect(calls.find(call => call.operation === "content.resolve")!.input).toEqual({ path: "/pricing" })
    resolved = undefined
    history.pushState(null, "", "/elsewhere")
    await vi.waitFor(() => expect(host.shadowRoot!.querySelector("[data-slot='comment-toolbar-edit']")).toBeNull())
  })

  it("hides the writing tools from a reader who may not write", async () => {
    const { host } = await mounted({ canRead: true, canWrite: false, user: null })
    expect(host.shadowRoot!.querySelector("[data-readonly]")).not.toBeNull()
  })

  it("removes everything when destroyed, and undoes the history patch", async () => {
    const push = history.pushState
    const handle = await mounted()
    expect(history.pushState).not.toBe(push)
    handle.destroy()
    expect(handle.host.isConnected).toBe(false)
    expect(history.pushState).toBe(push)
  })

  it("treats /pricing and /pricing/ as one subject, and the base without a trailing slash as the root", async () => {
    history.replaceState(null, "", "/pricing/")
    await mounted()
    const lists = () => calls.filter(call => call.operation === "comments.list").map(call => JSON.stringify(call.input))
    await vi.waitFor(() => expect(lists().length).toBeGreaterThan(0))
    expect(lists()[0]).toContain('"/pricing"')
    expect(lists()[0]).not.toContain("/pricing/")
    const before = lists().length
    history.pushState(null, "", "/pricing")
    history.pushState(null, "", "/pricing/")
    await new Promise(done => setTimeout(done, 20))
    // Neither move is another page, so the threads are not asked for again.
    expect(lists().length).toBe(before)
    expect(appPathname("/portal", "/portal/")).toBe("/")
  })

  it("hides while the page is excluded and comes back, without a hotkey in between", async () => {
    const handle = await mounted()
    const layer = () => handle.host.shadowRoot!.querySelector("[data-slot='comment-layer']")
    expect(layer()).not.toBeNull()
    handle.setActive(false)
    await vi.waitFor(() => expect(layer()).toBeNull())
    expect(handle.host.style.display).toBe("none")
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "c" }))
    await new Promise(done => setTimeout(done, 10))
    expect(handle.host.shadowRoot!.querySelector("[data-active]")).toBeNull()
    handle.setActive(true)
    await vi.waitFor(() => expect(layer()).not.toBeNull())
    expect(handle.host.style.display).toBe("")
  })

  it("starts hidden for a landing page that the options leave out", async () => {
    const handle = await mounted(undefined, "/", false)
    expect(handle.host.style.display).toBe("none")
    expect(handle.host.shadowRoot!.querySelector("[data-slot='comment-layer']")).toBeNull()
    handle.setActive(true)
    await vi.waitFor(() => expect(handle.host.shadowRoot!.querySelector("[data-slot='comment-toolbar']")).not.toBeNull())
  })

  it("draws its icons as SVG elements, never from markup", async () => {
    const innerHTML = vi.spyOn(Element.prototype, "innerHTML", "set")
    const { host } = await mounted()
    const icon = host.shadowRoot!.querySelector("[data-slot='comment-toolbar-mode'] svg")
    expect(icon?.getAttribute("viewBox")).toBe("0 0 256 256")
    expect(icon?.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(10)
    expect(innerHTML).not.toHaveBeenCalled()
    innerHTML.mockRestore()
  })
})

describe("the overlay theme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("class")
    document.documentElement.removeAttribute("data-theme")
    document.documentElement.removeAttribute("style")
  })

  it("reads the theme that the app picked", () => {
    const root = document.documentElement
    expect(appTheme(root)).toBeUndefined()
    root.classList.add("dark")
    expect(appTheme(root)).toBe("dark")
    root.classList.replace("dark", "light")
    expect(appTheme(root)).toBe("light")
    root.className = ""
    root.setAttribute("data-theme", "dark")
    expect(appTheme(root)).toBe("dark")
    root.removeAttribute("data-theme")
    root.style.colorScheme = "dark"
    expect(appTheme(root)).toBe("dark")
  })

  it("follows the class, data-theme, and color-scheme of <html> on the host, and the system otherwise", async () => {
    const { host } = await mounted()
    expect(host.classList.contains("dark")).toBe(false)
    expect(host.style.colorScheme).toBe("")
    document.documentElement.classList.add("dark")
    await vi.waitFor(() => expect(host.classList.contains("dark")).toBe(true))
    expect(host.style.colorScheme).toBe("dark")
    document.documentElement.classList.remove("dark")
    document.documentElement.setAttribute("data-theme", "light")
    await vi.waitFor(() => expect(host.classList.contains("dark")).toBe(false))
    expect(host.style.colorScheme).toBe("light")
    document.documentElement.removeAttribute("data-theme")
    await vi.waitFor(() => expect(host.style.colorScheme).toBe(""))
  })
})
