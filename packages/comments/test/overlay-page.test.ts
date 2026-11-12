// @vitest-environment happy-dom
import { connectRealtimeRoom } from "@vite-hub/realtime/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as page from "../src/page.ts"
import { defineCommentSubject } from "../src/operations-core/define.ts"
import { api } from "../src/overlay/api.ts"
import { commentsButton, openList, pageTools, press, serveComments, startOverlay, tool, type } from "./overlay-harness.ts"

import type { ElementAnchor } from "../src/types.ts"

const room = vi.hoisted(() => ({
  clientId: 0,
  states: vi.fn(() => new Map<number, Record<string, unknown>>()),
  people: () => [],
  onUpdate: vi.fn(),
  onChange: vi.fn(),
  notify: vi.fn(),
  setLocal: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock("@vite-hub/realtime/client", () => ({ connectRealtimeRoom: vi.fn(() => room) }))

const ada = { id: "ada", name: "Ada" }
const anchor = { kind: "element", selector: "h1", x: 500, y: 500 } satisfies ElementAnchor

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let tools: ReturnType<typeof pageTools>
let shadow: ShadowRoot
let overlay: HTMLElement

/** A page with a Content field, presence, and one thread on the title. */
async function open(options: { content?: boolean } = {}) {
  const server = await serveComments({ identify: () => ada }, { realtime: true })
  await server.comments.create({ page: "/", anchor, body: "First comment", author: ada })
  if (options.content !== false) {
    // The Content runtime is the Console's. These tests answer its two field routes.
    const session = api.session
    vi.spyOn(api, "session").mockImplementation(async (page) => {
      const [error, value] = await session(page)
      return error ? [error, undefined] : [undefined, { ...value, content: true }]
    })
  }
  tools = pageTools()
  document.documentElement.append(tools.pill)
  ;({ shadow, overlay } = await startOverlay(tools))
  await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-pin"]')).not.toBeNull())
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  history.replaceState(null, "", "/")
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 40))
  document.body.innerHTML = '<h1 data-content-field="settings#title">Published</h1>'
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [document.querySelector("h1")!] })
  room.states.mockReturnValue(new Map())
  vi.spyOn(api, "field").mockResolvedValue([undefined, { field: "settings#title", value: "Unpublished", editable: true, digest: "draft-digest", collection: "settings", id: "settings" }])
  vi.spyOn(api, "saveField").mockResolvedValue([undefined, { field: "settings#title", value: "Published", digest: "saved-digest" }])
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-comments, vitehub-pill")) element.remove()
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.style.colorScheme = ""
  document.documentElement.className = ""
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, "elementsFromPoint")
  getSelection()?.removeAllRanges()
})

async function startEdit() {
  const title = document.querySelector("h1")!
  await vi.waitFor(() => expect(tool(tools.bar, "Edit text (E)")).not.toBeNull())
  if (tool(tools.bar, "Edit text (E)")!.getAttribute("aria-pressed") !== "true") tool(tools.bar, "Edit text (E)")!.click()
  title.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }))
  await vi.waitFor(() => expect(title.textContent).toBe("Unpublished"))
  return title
}

describe("the Comments overlay on a page", () => {
  it("joins the new page's room when two pages map to the same subject", async () => {
    await serveComments({
      identify: () => ada,
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: () => ({ kind: "drop", id: "one" }),
    }, { realtime: true })
    tools = pageTools()
    document.documentElement.append(tools.pill)
    ;({ shadow, overlay } = await startOverlay(tools))
    await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalledWith("comments", page.commentRoom("/"), expect.anything()))
    history.pushState(null, "", "/v2")
    await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalledWith("comments", page.commentRoom("/v2"), expect.objectContaining({ params: { page: "/v2" } })))
  })

  it("shares changes only through the authorized page room and ignores cursor-only updates", async () => {
    const { comments, requests } = await open({ content: false })
    await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalled())
    expect(connectRealtimeRoom).toHaveBeenCalledWith("comments", page.commentRoom("/"), expect.objectContaining({ params: { page: "/" } }))
    expect(vi.mocked(connectRealtimeRoom).mock.calls[0]![2]?.changes).not.toBe(true)
    const update = room.onUpdate.mock.calls[0]![0] as () => void
    const count = () => requests.filter(request => request.path.includes("/threads?")).length
    await comments.create({ page: "/", anchor, body: "From another browser", author: ada })
    const before = count()
    room.states.mockReturnValue(new Map([[1, { commentsChange: "changed", cursor: { x: 0 } }]]))
    update()
    await vi.waitFor(() => expect(shadow.querySelectorAll('[data-slot="comment-pin"]')).toHaveLength(2))
    expect(count()).toBeGreaterThan(before)
    const refreshed = count()
    room.states.mockReturnValue(new Map([[1, { commentsChange: "changed", cursor: { x: 10 } }]]))
    update()
    expect(count()).toBe(refreshed)
    room.states.mockReturnValue(new Map([[0, { commentsChange: "own change" }], [1, { commentsChange: "changed" }]]))
    update()
    expect(count()).toBe(refreshed)
    // A local write announces to this page's readers through awareness, too.
    await openList(tools.bar)
    const panel = tools.panel()!
    await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-panel-item"]')).not.toBeNull())
    panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
    await vi.waitFor(() => expect(panel.querySelector('textarea[aria-label="Reply"]')).not.toBeNull())
    const input = panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
    await type(input, "Local change")
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(room.setLocal).toHaveBeenCalledWith("commentsChange", expect.any(String)))
    expect(room.notify).not.toHaveBeenCalled()
  })

  it("ends edit mode when comment mode, pressed while the new page loads, comes back", async () => {
    await open()
    await startEdit()
    const session = vi.mocked(api.session).getMockImplementation()!
    const held = deferred<void>()
    vi.mocked(api.session).mockImplementation(async (next) => {
      if (next === "/next") await held.promise
      return await session(next)
    })
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(vi.mocked(api.session)).toHaveBeenCalledWith("/next"))
    press(document.body, "c")
    held.resolve()
    await vi.waitFor(() => expect(commentsButton(tools.bar)!.getAttribute("aria-pressed")).toBe("true"))
    expect(tool(tools.bar, "Edit text (E)")!.getAttribute("aria-pressed")).toBe("false")
  })

  it("keeps edit mode when edit mode, pressed after comment mode while the new page loads, came last", async () => {
    await open()
    await vi.waitFor(() => expect(tool(tools.bar, "Edit text (E)")).not.toBeNull())
    const session = vi.mocked(api.session).getMockImplementation()!
    const held = deferred<void>()
    vi.mocked(api.session).mockImplementation(async (next) => {
      if (next === "/next") await held.promise
      return await session(next)
    })
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(vi.mocked(api.session)).toHaveBeenCalledWith("/next"))
    press(document.body, "c")
    tool(tools.bar, "Edit text (E)")!.click()
    held.resolve()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer']")).not.toBeNull())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(tool(tools.bar, "Edit text (E)")!.getAttribute("aria-pressed")).toBe("true")
    expect(commentsButton(tools.bar)!.getAttribute("aria-pressed")).toBe("false")
  })

  it("ends edit mode on Esc while the new page loads", async () => {
    await open()
    await vi.waitFor(() => expect(tool(tools.bar, "Edit text (E)")).not.toBeNull())
    const session = vi.mocked(api.session).getMockImplementation()!
    const held = deferred<void>()
    vi.mocked(api.session).mockImplementation(async (next) => {
      if (next === "/next") await held.promise
      return await session(next)
    })
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(vi.mocked(api.session)).toHaveBeenCalledWith("/next"))
    tool(tools.bar, "Edit text (E)")!.click()
    await vi.waitFor(() => expect(tool(tools.bar, "Edit text (E)")!.getAttribute("aria-pressed")).toBe("true"))
    press(document.body, "Escape")
    await vi.waitFor(() => expect(tool(tools.bar, "Edit text (E)")!.getAttribute("aria-pressed")).toBe("false"))
    held.resolve()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer']")).not.toBeNull())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(tool(tools.bar, "Edit text (E)")!.getAttribute("aria-pressed")).toBe("false")
  })

  it.each([["another subject", false], ["the same subject", true]])("opens the composer on text selected while a page of %s loads", async (_, shared) => {
    await serveComments({
      identify: () => ada,
      ...(shared ? { subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })], page: () => ({ kind: "drop", id: "same" }) } : {}),
    })
    tools = pageTools()
    document.documentElement.append(tools.pill)
    ;({ shadow, overlay } = await startOverlay(tools))
    await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 100, 20))
    const session = api.session
    const held = deferred<void>()
    vi.spyOn(api, "session").mockImplementation(async (next) => {
      if (next === "/next") await held.promise
      return await session(next)
    })
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledWith("/next"))
    const range = document.createRange()
    range.selectNodeContents(document.querySelector("h1")!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    press(document.body, "c")
    held.resolve()
    await vi.waitFor(() => expect(shadow.querySelector("textarea[aria-label='Comment']")).not.toBeNull())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shadow.querySelector("textarea[aria-label='Comment']")).not.toBeNull()
  })

  it("ignores an older inline field lookup after a new selection", async () => {
    await open()
    const first = document.querySelector("h1")!
    const second = document.createElement("h2")
    second.setAttribute("data-content-field", "settings#other")
    second.textContent = "Other published"
    document.body.append(second)
    const pending = deferred<Awaited<ReturnType<typeof api.field>>>()
    vi.mocked(api.field).mockImplementationOnce(() => pending.promise)
    tool(tools.bar, "Edit text (E)")!.click()
    first.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await vi.waitFor(() => expect(api.field).toHaveBeenCalledTimes(1))
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [second] })
    second.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await vi.waitFor(() => expect(second.hasAttribute("data-vitehub-editing")).toBe(true))
    pending.resolve([undefined, { field: "settings#title", value: "Stale draft", editable: true, digest: "old", collection: "settings", id: "settings" }])
    await pending.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(first.textContent).toBe("Published")
    expect(first.hasAttribute("data-vitehub-editing")).toBe(false)
    expect(second.hasAttribute("data-vitehub-editing")).toBe(true)
  })

  it.each(["teardown", "leaving edit mode"])("ignores an inline field lookup that finishes after %s", async (action) => {
    await open()
    const title = document.querySelector("h1")!
    const pending = deferred<Awaited<ReturnType<typeof api.field>>>()
    vi.mocked(api.field).mockImplementationOnce(() => pending.promise)
    tool(tools.bar, "Edit text (E)")!.click()
    title.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await vi.waitFor(() => expect(api.field).toHaveBeenCalledOnce())
    if (action === "teardown") overlay.remove()
    else tool(tools.bar, "Comment on the page (C)")!.click()
    pending.resolve([undefined, { field: "settings#title", value: "Stale draft", editable: true, digest: "old", collection: "settings", id: "settings" }])
    await pending.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(title.textContent).toBe("Published")
    expect(title.hasAttribute("data-vitehub-editing")).toBe(false)
  })

  it("keeps an inline edit's authorization page when the router navigates before save", async () => {
    const { requests } = await open()
    const title = await startEdit()
    expect(api.field).toHaveBeenCalledWith("settings#title", "/")
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(requests.some(request => request.path.includes("subjectId=%2Fnext"))).toBe(true))
    title.textContent = "Edited on the original page"
    title.dispatchEvent(new Event("blur"))
    await vi.waitFor(() => expect(api.saveField).toHaveBeenCalledWith({ field: "settings#title", value: "Edited on the original page", ifDigest: "draft-digest" }, "/"))
  })

  it.each(["body swap", "astro:before-swap", "turbo:before-render"])("saves the open inline edit on %s without a blur", async (event) => {
    await open()
    const title = await startEdit()
    title.textContent = "Edited before navigation"
    const before = document.body
    const next = document.createElement("body")
    next.innerHTML = '<h1 data-content-field="settings#title">Next page</h1>'
    try {
      if (event !== "body swap") {
        document.dispatchEvent(new Event(event))
        expect(api.saveField).toHaveBeenCalledOnce()
        expect(title.hasAttribute("data-vitehub-editing")).toBe(false)
      }
      before.replaceWith(next)
      await vi.waitFor(() => expect(api.saveField).toHaveBeenCalledWith({ field: "settings#title", value: "Edited before navigation", ifDigest: "draft-digest" }, "/"))
      expect(title.hasAttribute("data-vitehub-editing")).toBe(false)
    }
    finally {
      next.replaceWith(before)
    }
  })

  it.each(["comment", "edit"])("restores %s styling after an Astro root, head, and body swap", async (mode) => {
    await open()
    const button = await vi.waitFor(() => {
      const found = tool(tools.bar, mode === "comment" ? "Comment on the page (C)" : "Edit text (E)")
      expect(found).not.toBeNull()
      return found!
    })
    button.click()
    const style = [...document.head.querySelectorAll("style")].find(element => element.textContent?.includes("vitehub-edit-mode"))!
    const before = document.body
    const next = document.createElement("body")
    next.innerHTML = '<h1 data-content-field="settings#title">Next page</h1>'
    try {
      document.documentElement.className = "next-page"
      style.remove()
      before.replaceWith(next)
      await vi.waitFor(() => {
        expect(document.documentElement.classList.contains(`vitehub-${mode}-mode`)).toBe(true)
        expect(style.parentElement).toBe(document.head)
      })
      expect(document.documentElement.classList.contains("next-page")).toBe(true)
      expect(room.destroy).not.toHaveBeenCalled()
    }
    finally {
      next.replaceWith(before)
    }
  })

  it("keeps the overlay, an unsent reply, and polling through a body swap", async () => {
    const server = await open()
    shadow.querySelector<HTMLButtonElement>('[data-slot="comment-pin"]')!.click()
    await vi.waitFor(() => expect(shadow.querySelector('textarea[aria-label="Reply"]')).not.toBeNull())
    const input = shadow.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
    await type(input, "Unsent reply")
    const before = document.body
    const next = document.createElement("body")
    next.innerHTML = '<h1 data-content-field="settings#title">Next page</h1>'
    try {
      before.replaceWith(next)
      expect(room.destroy).not.toHaveBeenCalled()
      expect(overlay.isConnected).toBe(true)
      expect(shadow.querySelector('textarea[aria-label="Reply"]')).toBe(input)
      expect(input.value).toBe("Unsent reply")
      const lists = server.requests.filter(request => request.path.startsWith("/api/_vitehub/comments/threads?")).length
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(server.requests.filter(request => request.path.startsWith("/api/_vitehub/comments/threads?")).length).toBe(lists + 1))
    }
    finally {
      next.replaceWith(before)
    }
  })

  it("does not resume startup when the pill exits during the session request", async () => {
    await serveComments({ identify: () => ada })
    const pending = deferred<Awaited<ReturnType<typeof api.session>>>()
    vi.spyOn(api, "session").mockReturnValueOnce(pending.promise)
    const pushState = history.pushState
    tools = pageTools()
    const started = await startOverlay(tools)
    tools.controller.abort()
    if (typeof started.cleanup === "function") started.cleanup()
    pending.resolve([undefined, { user: ada, can: { read: true, comment: true, resolve: false }, realtime: true, content: false }])
    await pending.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(started.overlay.isConnected).toBe(false)
    expect(connectRealtimeRoom).not.toHaveBeenCalled()
    expect(history.pushState).toBe(pushState)
    expect(vi.getTimerCount()).toBe(0)
    expect(tools.bar.hidden).toBe(true)
  })

  it.each(["dark", "light"])("follows the page's data-theme=%s and its changes", async (theme) => {
    const opposite = theme === "dark" ? "light" : "dark"
    document.documentElement.style.colorScheme = opposite
    document.documentElement.dataset.theme = theme
    await open()
    expect(overlay.style.colorScheme).toBe(theme)
    document.documentElement.dataset.theme = opposite
    await vi.waitFor(() => expect(overlay.style.colorScheme).toBe(opposite))
  })

  it.each(['"><image href="x" onerror="alert(document.domain)"/><!--', "#A1b2C3"])("draws a remote cursor color safely: %s", async (color) => {
    room.states.mockReturnValue(new Map([[1, { user: { id: "guest:remote", name: "Visitor", color }, cursor: { selector: "h1", x: 500, y: 500 } }]]))
    await open()
    window.dispatchEvent(new Event("resize"))
    await vi.waitFor(() => expect(shadow.querySelector(".cursor svg path")).not.toBeNull())
    const fill = shadow.querySelector(".cursor svg path")!.getAttribute("fill")
    expect(fill).toMatch(/^#[\da-f]{6}$/i)
    if (color === "#A1b2C3") expect(fill).toBe(color)
    expect(shadow.querySelector(".cursor image, .cursor [onerror]")).toBeNull()
  })

  it("names the hosted Console for a saved draft, without a link", async () => {
    await open()
    const title = await startEdit()
    title.textContent = "Updated"
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(shadow.querySelector(".toast")?.textContent).toContain("console.vitehub.dev"))
    expect(shadow.querySelector(".toast a")).toBeNull()
  })

  it("names the hosted Console for a field that is not plain text, and opens no page tool", async () => {
    vi.mocked(api.field).mockResolvedValue([undefined, { field: "settings#title", value: null, editable: false, digest: "draft", collection: "settings", id: "home/hero" }])
    await open()
    await vi.waitFor(() => expect(tool(tools.bar, "Edit text (E)")).not.toBeNull())
    tool(tools.bar, "Edit text (E)")!.click()
    document.querySelector("h1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await vi.waitFor(() => expect(shadow.querySelector(".toast")?.textContent).toContain("Edit it in the Console at console.vitehub.dev."))
    expect(shadow.querySelector(".toast a")).toBeNull()
    expect(tools.context.openTool).not.toHaveBeenCalled()
  })

  it("restores the published text on Escape and leaves an unchanged draft unsaved", async () => {
    await open()
    const title = await startEdit()
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(title.textContent).toBe("Published")
    await startEdit()
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(api.saveField).not.toHaveBeenCalled()
  })

  it("hides Edit from a person who may only read", async () => {
    await serveComments({ identify: () => ada, authorize: ({ action }) => action === "read" })
    vi.spyOn(api, "session").mockResolvedValue([undefined, { user: ada, can: { read: true, comment: false, resolve: false }, realtime: false, content: true }])
    tools = pageTools()
    ;({ shadow } = await startOverlay(tools))
    await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
    expect(tool(tools.bar, "Edit text (E)")).toBeNull()
    expect(tool(tools.bar, "Comment on the page (C)")).toBeNull()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }))
    expect(document.documentElement.classList.contains("vitehub-edit-mode")).toBe(false)
  })
})
