// @vitest-environment happy-dom
import { connectRealtimeRoom } from "@vite-hub/realtime/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as page from "../src/page.ts"
import { api } from "../src/overlay/api.ts"
import { pageTools, serveComments, startOverlay, tool, type } from "./overlay-harness.ts"

import type { ElementAnchor } from "../src/types.ts"

const room = vi.hoisted(() => ({
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
    vi.spyOn(api, "session").mockImplementation(async () => {
      const [error, value] = await session()
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
      await vi.waitFor(() => expect(api.saveField).toHaveBeenCalledWith({ field: "settings#title", value: "Edited before navigation", ifDigest: "draft-digest" }))
      expect(title.hasAttribute("data-vitehub-editing")).toBe(false)
    }
    finally {
      next.replaceWith(before)
    }
  })

  it.each(["comment", "edit"])("restores %s styling after an Astro root, head, and body swap", async (mode) => {
    await open()
    const button = await vi.waitFor(() => {
      const found = tool(tools.bar, mode === "comment" ? "Comment (C)" : "Edit text (E)")
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

  it("links a saved draft to Content below the app base", async () => {
    vi.spyOn(page, "commentsApiRoute").mockReturnValue("/portal/api/_vitehub/comments")
    await open()
    const title = await startEdit()
    title.textContent = "Updated"
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(shadow.querySelector('a[href="/portal/_vitehub/content"]')?.textContent).toBe("Review and publish"))
  })

  it("links a field that is not plain text to Content", async () => {
    vi.mocked(api.field).mockResolvedValue([undefined, { field: "settings#title", value: null, editable: false, digest: "draft", collection: "settings", id: "settings" }])
    await open()
    await vi.waitFor(() => expect(tool(tools.bar, "Edit text (E)")).not.toBeNull())
    tool(tools.bar, "Edit text (E)")!.click()
    document.querySelector("h1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await vi.waitFor(() => expect(shadow.querySelector('a[href="/_vitehub/content"]')?.textContent).toBe("Open Content"))
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
    await vi.waitFor(() => expect(tool(tools.bar, "Comments on this page")).not.toBeNull())
    expect(tool(tools.bar, "Edit text (E)")).toBeNull()
    expect(tool(tools.bar, "Comment (C)")).toBeNull()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }))
    expect(document.documentElement.classList.contains("vitehub-edit-mode")).toBe(false)
  })
})
