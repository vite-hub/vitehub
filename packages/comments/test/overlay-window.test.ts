// @vitest-environment happy-dom
import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { press, serveComments, type } from "./overlay-harness.ts"

import type { ElementAnchor } from "../src/types.ts"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ onUpdate: vi.fn(), onChange: vi.fn(), notify: vi.fn(), setLocal: vi.fn(), destroy: vi.fn(), people: () => [], states: () => new Map() })),
}))

const ada = { id: "ada", name: "Ada Lovelace" }
const anchor = { kind: "element", selector: "main > h1", x: 0, y: 0 } satisfies ElementAnchor
// As the Comments plugin registers it: a lazy tool that `?comment=<n>` opens.
const tool = { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", hotkey: "c", script: "/overlay.js", lazy: true, param: "comment" }

/** The page tools session, and the real Comments API of a site where Ada may comment. */
async function site(lazy = false) {
  const server = await serveComments({ identify: () => ada })
  const api = server.fetch.getMockImplementation()!
  const tools = [lazy ? tool : { ...tool, lazy: false }]
  server.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), location.href)
    if (url.pathname !== "/_vitehub/page/session") return await api(input, init)
    expect(url.searchParams.get("page")).toBe(location.pathname)
    return Response.json({ tools })
  })
  return server
}

async function openPanel() {
  await loadViteHubPageTools({ load: () => import("../src/overlay/index.ts") })
  const bar = document.querySelector("vitehub-pill")!.querySelector<HTMLElement>("vitehub-tool[slot=comments]")!
  const list = () => bar.shadowRoot?.querySelector<HTMLButtonElement>("button[title=\"Comments on this page\"]")
  await vi.waitFor(() => expect(list()).toBeTruthy())
  list()!.click()
  const window = document.querySelector<HTMLElement>("vitehub-window")!
  const panel = window.shadowRoot!.querySelector(".body > div")!.shadowRoot!
  return { bar, list, window, panel }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal("confirm", vi.fn(() => true))
  history.replaceState(null, "", "/?vitehub")
  document.body.innerHTML = "<main><h1>Title</h1></main>"
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 40))
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(window.confirm).mockReturnValue(true)
  document.querySelector("vitehub-pill")?.shadowRoot?.querySelector<HTMLButtonElement>("button.exit")?.click()
  for (const element of document.querySelectorAll("vitehub-pill, vitehub-comments, vitehub-window, vitehub-tools-off")) element.remove()
  localStorage.removeItem("vitehub-tools-off")
  document.documentElement.className = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the Comments list in the pill's window", () => {
  it.each(["pushState", "replaceState"] as const)("opens a same-page query link after %s", async (method) => {
    const { comments } = await site()
    const [, thread] = await comments.create({ page: "/", anchor, body: "Client navigation link", author: ada })
    await comments.resolve(thread!.id, { by: ada })
    await openPanel()
    history[method](null, "", `/?comment=${thread!.n}`)
    const shadow = document.querySelector("vitehub-comments")!.shadowRoot!
    await vi.waitFor(() => expect(shadow.querySelector(`[data-slot="comment-thread"][aria-label="Comment ${thread!.n}"]`)?.textContent).toContain("Client navigation link"))
  })

  it("shows CommentPanel with the page as its title, and follows navigation", async () => {
    await site()
    const { panel } = await openPanel()
    await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-panel-title"]')!.textContent).toBe("/"))
    expect(panel.querySelector('[data-slot="comment-panel-empty"]')!.textContent).toBe("No open comments.")
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-panel-title"]')!.textContent).toBe("/next"))
  })

  it("is dark like the pill on light and dark pages", async () => {
    await site()
    const { panel } = await openPanel()
    expect(panel.querySelector("style")!.textContent).toContain("color-scheme: dark")
    expect(panel.querySelector("style")!.textContent).toContain("--ui-bg: #0a0a0a")
  })

  it("keeps an open thread and its reply draft while the window is hidden", async () => {
    const { comments } = await site()
    await comments.create({ page: "/", anchor, body: "Original comment", author: ada })
    const { panel, window: pageWindow, list } = await openPanel()
    await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-panel-item"]')).toBeTruthy())
    panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
    await vi.waitFor(() => expect(panel.querySelector('textarea[aria-label="Reply"]')).toBeTruthy())
    const input = panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
    await type(input, "Unsent reply")
    pageWindow.shadowRoot!.querySelector<HTMLButtonElement>(".hide")!.click()
    await vi.waitFor(() => expect(list()!.getAttribute("aria-pressed")).toBe("false"))
    window.dispatchEvent(new Event("scroll"))
    await new Promise(resolve => setTimeout(resolve, 50))
    list()!.click()
    expect(panel.querySelector('textarea[aria-label="Reply"]')).toBe(input)
    expect(input.value).toBe("Unsent reply")
    // Turning the tools off asks first, because the reply was not sent.
    vi.mocked(window.confirm).mockReturnValue(false)
    document.querySelector("vitehub-pill")!.shadowRoot!.querySelector<HTMLButtonElement>("button[aria-label=\"Turn off ViteHub tools\"]")!.click()
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(document.querySelector("vitehub-comments")).not.toBeNull()
  })

  it("clears a sent reply and lets the tools turn off without a warning", async () => {
    const { comments } = await site()
    const [, thread] = await comments.create({ page: "/", anchor, body: "Original comment", author: ada })
    const { panel } = await openPanel()
    await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-panel-item"]')).toBeTruthy())
    panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
    await vi.waitFor(() => expect(panel.querySelector('textarea[aria-label="Reply"]')).toBeTruthy())
    const input = panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
    await type(input, "Sent reply")
    press(input, "Enter")
    await vi.waitFor(() => expect(panel.querySelectorAll('[data-slot="comment-reply"]')).toHaveLength(2))
    expect((await comments.get(thread!.id))[1]!.messages.map(message => message.body)).toEqual(["Original comment", "Sent reply"])
    await vi.waitFor(() => expect(panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!.value).toBe(""))
    document.querySelector("vitehub-pill")!.shadowRoot!.querySelector<HTMLButtonElement>("button[aria-label=\"Turn off ViteHub tools\"]")!.click()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it("starts the Comments tool from a ?comment=<n> link after exit and opens that thread", async () => {
    const { comments } = await site(true)
    const [, thread] = await comments.create({ page: "/", anchor, body: "Linked comment", author: ada })
    history.replaceState(null, "", `/?comment=${thread!.n}`)
    document.cookie = "vitehub-tools=1"
    localStorage.setItem("vitehub-tools-off", "1")
    try {
      await loadViteHubPageTools({ load: () => import("../src/overlay/index.ts") })
      await vi.waitFor(() => expect(document.querySelector("vitehub-comments")).not.toBeNull())
      const shadow = document.querySelector("vitehub-comments")!.shadowRoot!
      await vi.waitFor(() => expect(shadow.querySelector(`[data-slot="comment-thread"][aria-label="Comment ${thread!.n}"]`)?.textContent).toContain("Linked comment"))
    }
    finally {
      document.cookie = "vitehub-tools=; max-age=0"
    }
  })
})
