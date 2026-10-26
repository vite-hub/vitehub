// @vitest-environment happy-dom
import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tool = { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", hotkey: "c", script: "/overlay.js" }

/** The page tools session and the Comments API of a site where this person may `read`, and `comment` when `comment`. */
function site(can: { read: boolean, comment: boolean }) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = String(input)
    if (path === "/_vitehub/page/session") return Response.json({ tools: [tool] })
    if (path === "/api/_vitehub/comments/session") {
      return Response.json({ data: { user: { id: "ada", name: "Ada Lovelace" }, can: { ...can, resolve: can.comment }, realtime: false, content: false } })
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
  history.replaceState(null, "", "/?vitehub")
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-pill, vitehub-comments")) element.remove()
  document.documentElement.className = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the Comments page tool", () => {
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
