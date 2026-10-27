// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readGuest } from "../src/overlay/api.ts"

import type { CommentsSession } from "../src/overlay/api.ts"

vi.mock("@vite-hub/realtime/client", () => ({ connectRealtimeRoom: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = "<h1>Page title</h1>"
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [document.querySelector("h1")!] })
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 40))
})

afterEach(() => {
  document.querySelector("vitehub-comments")?.remove()
  Reflect.deleteProperty(document, "elementsFromPoint")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function compose(user: CommentsSession["user"]) {
  const requests: RequestInit[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ data: { user, can: { read: true, comment: true, resolve: true }, content: false, realtime: false } })
    if (init?.method === "POST") {
      requests.push(init)
      return Response.json({ error: { code: "COMMENTS_FAILED", why: "Fixture keeps the composer open." } })
    }
    return Response.json({ data: [] })
  }))
  await import("../src/overlay/index.ts")
  if (!document.querySelector("vitehub-comments")) document.body.append(document.createElement("vitehub-comments"))
  const shadow = document.querySelector("vitehub-comments")!.shadowRoot!
  await vi.waitFor(() => expect(shadow.querySelector(".toolbar button")).not.toBeNull())
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
  document.querySelector("h1")!.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 10, bubbles: true }))
  const input = shadow.querySelector<HTMLTextAreaElement>("textarea")!
  input.value = "Please fix this title"
  input.dispatchEvent(new Event("input"))
  const button = shadow.querySelector<HTMLButtonElement>(".compose button.primary")!
  return { requests, shadow, button }
}

describe("Console guest comment authors", () => {
  it("saves the entered guest name and sends a distinct guest identity", async () => {
    const { requests, shadow, button } = await compose({ id: "guest:console", name: "Guest", guest: true })
    shadow.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!.value = "  Ana García  "
    button.click()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const guest = readGuest()!
    expect(guest.name).toBe("Ana García")
    expect(guest.id).not.toBe("console")
    const headers = new Headers(requests[0]!.headers)
    expect(headers.get("x-vitehub-comments-guest-id")).toBe(guest.id)
    expect(decodeURIComponent(headers.get("x-vitehub-comments-guest-name")!)).toBe("Ana García")
  })

  it("requires a name from a new Console guest", async () => {
    const { requests, shadow, button } = await compose({ id: "guest:console", name: "Guest", guest: true })
    button.click()
    expect(requests).toHaveLength(0)
    expect(readGuest()).toBeUndefined()
    expect(shadow.activeElement).toBe(shadow.querySelector('input[aria-label="Your name"]'))
  })

  it("keeps signed-in Console users on their account identity", async () => {
    const { requests, shadow, button } = await compose({ id: "editor-1", name: "Editor" })
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
    button.click()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(new Headers(requests[0]!.headers).has("x-vitehub-comments-guest-id")).toBe(false)
    expect(readGuest()).toBeUndefined()
  })
})
