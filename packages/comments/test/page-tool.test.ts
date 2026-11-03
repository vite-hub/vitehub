// @vitest-environment happy-dom
import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"
import { connectRealtimeRoom } from "@vite-hub/realtime/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ onUpdate: vi.fn(), onChange: vi.fn(), destroy: vi.fn(), people: () => [], states: () => [] })),
}))

const tool = { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", hotkey: "c", script: "/overlay.js" }

/** The page tools session and the Comments API of a site where this person may `read`, and `comment` when `comment`. */
function site(can: { read: boolean, comment: boolean }, realtime = false) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = String(input)
    if (path === "/_vitehub/page/session") return Response.json({ tools: [tool] })
    if (path === "/api/_vitehub/comments/session") {
      return Response.json({ data: { user: { id: "ada", name: "Ada Lovelace" }, can: { ...can, resolve: can.comment }, realtime, content: false } })
    }
    if (path.startsWith("/api/_vitehub/comments/threads")) return Response.json({ data: [] })
    return Response.json({ error: { code: "NOT_FOUND", why: `No route ${path}.` } }, { status: 404 })
  }))
}

async function start() {
  await loadViteHubPageTools({ load: () => import("../src/overlay/index.ts") })
  const pill = document.querySelector("vitehub-pill")!
  const bar = pill.querySelector<HTMLElement>("vitehub-tool[slot=comments]")!
  return { pill, bar }
}

const comment = (bar: HTMLElement) => bar.shadowRoot?.querySelector<HTMLButtonElement>("button[title=\"Comment (C)\"]")

beforeEach(() => {
  vi.clearAllMocks()
  history.replaceState(null, "", "/?vitehub")
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  document.querySelector("vitehub-pill")?.shadowRoot?.querySelector<HTMLButtonElement>("button.exit")?.click()
  for (const element of document.querySelectorAll("vitehub-pill, vitehub-comments")) element.remove()
  document.documentElement.className = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the Comments page tool", () => {
  it.each([
    ["session", "exit"],
    ["threads", "exit"],
    ["session", "disconnect"],
    ["threads", "disconnect"],
  ])("stops startup after %s is pending and the overlay receives %s", async (stage, action) => {
    site({ read: true, comment: true }, true)
    const serve = fetch
    let respond!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { respond = resolve })
    const request = vi.fn((input: string) => String(input).startsWith(`/api/_vitehub/comments/${stage}`) ? pending : serve(input))
    vi.stubGlobal("fetch", request)
    const originalPush = history.pushState
    const originalReplace = history.replaceState
    const { pill, bar } = await start()
    await vi.waitFor(() => expect(request.mock.calls.some(([path]) => path.startsWith(`/api/_vitehub/comments/${stage}`))).toBe(true))
    if (action === "exit") pill.shadowRoot!.querySelector<HTMLButtonElement>("button.exit")!.click()
    else document.querySelector("vitehub-comments")!.remove()

    const documentListeners = vi.spyOn(document, "addEventListener")
    const windowListeners = vi.spyOn(window, "addEventListener")
    const resize = vi.spyOn(ResizeObserver.prototype, "observe")
    const mutations = vi.spyOn(MutationObserver.prototype, "observe")
    const poll = vi.spyOn(globalThis, "setInterval")
    respond(stage === "session"
      ? Response.json({ data: { user: { id: "ada", name: "Ada" }, can: { read: true, comment: true, resolve: true }, realtime: true, content: false } })
      : Response.json({ data: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(history.pushState).toBe(originalPush)
    expect(history.replaceState).toBe(originalReplace)
    expect(documentListeners).not.toHaveBeenCalled()
    expect(windowListeners).not.toHaveBeenCalled()
    expect(resize).not.toHaveBeenCalled()
    expect(mutations).not.toHaveBeenCalled()
    expect(poll).not.toHaveBeenCalled()
    expect(connectRealtimeRoom).not.toHaveBeenCalled()
    expect(document.querySelector("vitehub-comments")).toBeNull()
    if (stage === "session") {
      expect(bar.hidden).toBe(true)
      expect(request.mock.calls.some(([path]) => path.startsWith("/api/_vitehub/comments/threads"))).toBe(false)
    }
  })

  it("keeps the launch button's place, busy, until the session answers, so the pill does not shrink first", async () => {
    site({ read: true, comment: true })
    const serve = fetch
    let respond!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { respond = resolve })
    vi.stubGlobal("fetch", vi.fn((input: string) => String(input) === "/api/_vitehub/comments/session" ? pending : serve(input)))
    const { bar } = await start()
    await vi.waitFor(() => expect(document.querySelector("vitehub-comments")).not.toBeNull())
    const placeholder = bar.shadowRoot!.querySelector<HTMLButtonElement>("button")!
    expect(bar.hidden).toBe(false)
    expect([placeholder.textContent, placeholder.disabled, placeholder.getAttribute("aria-busy")]).toEqual(["Comments", true, "true"])
    respond(Response.json({ data: { user: { id: "ada", name: "Ada" }, can: { read: true, comment: true, resolve: true }, realtime: false, content: false } }))
    await vi.waitFor(() => expect(comment(bar)).toBeTruthy())
    expect(bar.shadowRoot!.querySelector("button[aria-busy]")).toBeNull()
  })

  it("draws its toolbar in its pill segment, without its own exit button", async () => {
    site({ read: true, comment: true })
    const { pill, bar } = await start()
    await vi.waitFor(() => expect(comment(bar)).toBeTruthy())
    expect(bar.hidden).toBe(false)
    expect(bar.shadowRoot!.querySelector("[role=group]")!.getAttribute("aria-label")).toBe("Comments")
    expect(bar.shadowRoot!.querySelector("[aria-label=\"Leave comment mode\"]")).toBeNull()
    // Pins, cursors, and cards stay in the overlay element, outside the pill.
    const overlay = document.querySelector("vitehub-comments")!
    expect(overlay.shadowRoot!.querySelector(".toolbar")).toBeNull()
    expect(pill.contains(overlay)).toBe(false)
  })

  it("enters comment mode with C and with its button", async () => {
    site({ read: true, comment: true })
    const { bar } = await start()
    await vi.waitFor(() => expect(comment(bar)).toBeTruthy())
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }))
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(true)
    expect(comment(bar)!.getAttribute("aria-pressed")).toBe("true")
    comment(bar)!.click()
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)
  })

  it("leaves comment mode and removes the overlay when the pill turns the page tools off", async () => {
    site({ read: true, comment: true })
    const { pill, bar } = await start()
    await vi.waitFor(() => expect(comment(bar)).toBeTruthy())
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }))
    // In comment mode a click on the page starts a comment. A click on the pill does not.
    pill.shadowRoot!.querySelector<HTMLButtonElement>("button[aria-label=\"Turn off ViteHub tools\"]")!.click()
    expect(document.querySelector("vitehub-comments")).toBeNull()
    expect(document.querySelector("vitehub-pill")).toBeNull()
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)
    expect(location.search).toBe("")
  })

  it("keeps its segment hidden when the Comments session does not allow reading", async () => {
    site({ read: false, comment: false })
    const { bar } = await start()
    await vi.waitFor(() => expect(document.querySelector("vitehub-comments")!.shadowRoot!.querySelector(".toast")).toBeTruthy())
    expect(bar.hidden).toBe(true)
  })
})
