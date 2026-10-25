// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/comments-overlay/overlay.css?inline", () => ({ default: ":root { --x: 1 } [data-slot='comment-layer'] { color: red }" }))

import { mount, trackNavigation } from "../src/comments-overlay/overlay.ts"
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

async function mounted(session: OverlaySession = { canRead: true, canWrite: true, user: { id: "ana", name: "Ana" } }, base = "/") {
  const handle = mount({ base, session })
  handles.push(handle)
  await vi.waitFor(() => expect(handle.host.shadowRoot!.querySelector("[data-slot='comment-toolbar']")).not.toBeNull())
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

  it("trackNavigation calls back on pushState, replaceState, and popstate", () => {
    const listener = vi.fn()
    const stop = trackNavigation(listener)
    history.pushState(null, "", "/a")
    history.replaceState(null, "", "/b")
    window.dispatchEvent(new PopStateEvent("popstate"))
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
    history.pushState(null, "", "/c")
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
