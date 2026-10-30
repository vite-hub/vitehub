// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { connectRealtimeRoom } from "@vite-hub/realtime/client"

import { readGuest, saveGuest } from "../src/overlay/api.ts"

import type { CommentsSession } from "../src/overlay/api.ts"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({
    states: () => new Map(),
    people: () => [],
    onUpdate: vi.fn(),
    onChange: vi.fn(),
    notify: vi.fn(),
    destroy: vi.fn(),
  })),
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  document.body.innerHTML = "<h1>Page title</h1>"
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [document.querySelector("h1")!] })
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 40))
})

afterEach(() => {
  document.querySelector("vitehub-comments")?.remove()
  document.querySelector("vitehub-pill")?.remove()
  Reflect.deleteProperty(document, "elementsFromPoint")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function compose(user: CommentsSession["user"], realtime = false) {
  const requests: RequestInit[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ data: { user, can: { read: true, comment: true, resolve: true }, content: false, realtime } })
    if (init?.method === "POST") {
      requests.push(init)
      return Response.json({ error: { code: "COMMENTS_FAILED", why: "Fixture keeps the composer open." } })
    }
    return Response.json({ data: [] })
  }))
  const { default: start } = await import("../src/overlay/index.ts")
  const pill = document.createElement("vitehub-pill")
  const bar = document.createElement("vitehub-tool")
  pill.append(bar)
  document.body.append(pill)
  start({
    tool: { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/overlay.js" },
    bar, signal: new AbortController().signal, open: false, exit: vi.fn(),
    createWindow: () => { throw new Error("Unexpected retained window") },
    openTool: vi.fn(async () => false), onOpen: vi.fn(), beforeExit: vi.fn(),
  })
  const shadow = document.querySelector("vitehub-comments")!.shadowRoot!
  await vi.waitFor(() => expect(bar.shadowRoot!.querySelector(".toolbar button")).not.toBeNull())
  if (realtime) await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalledTimes(1))
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
  document.querySelector("h1")!.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 10, bubbles: true }))
  const input = shadow.querySelector<HTMLTextAreaElement>("textarea")!
  input.value = "Please fix this title"
  input.dispatchEvent(new Event("input"))
  const button = shadow.querySelector<HTMLButtonElement>(".compose button.primary")!
  return { requests, shadow, button }
}

describe("Console guest comment authors", () => {
  it("lets Realtime generate a distinct identity for an unnamed Console guest", async () => {
    await compose(null, true)
    expect(connectRealtimeRoom).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connectRealtimeRoom).mock.calls[0]![2]?.identity).toBeUndefined()
  })

  it("rejoins the active room with the saved identity after the first name is entered", async () => {
    const { requests, shadow, button } = await compose(null, true)
    const initialRoom = vi.mocked(connectRealtimeRoom).mock.results[0]!.value
    shadow.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!.value = "Ana García"
    button.click()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const guest = readGuest()!
    expect(initialRoom.destroy).toHaveBeenCalledTimes(1)
    expect(connectRealtimeRoom).toHaveBeenCalledTimes(2)
    expect(vi.mocked(connectRealtimeRoom).mock.calls[1]![2]?.identity).toEqual({ id: `guest:${guest.id}`, name: "Ana García (guest)" })
  })

  it("uses the saved browser identity when a Console guest joins on a later page", async () => {
    const guest = saveGuest("Ana García")
    await compose(null, true)
    expect(vi.mocked(connectRealtimeRoom).mock.calls[0]![2]?.identity).toEqual({ id: `guest:${guest.id}`, name: "Ana García (guest)" })
  })

  it("saves the entered guest name and sends a distinct guest identity", async () => {
    const { requests, shadow, button } = await compose(null)
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
    const { requests, shadow, button } = await compose(null)
    button.click()
    expect(requests).toHaveLength(0)
    expect(readGuest()).toBeUndefined()
    expect(shadow.activeElement).toBe(shadow.querySelector('input[aria-label="Your name"]'))
  })

  it("keeps signed-in Console users on their account identity", async () => {
    const { requests, shadow, button } = await compose({ id: "editor-1", name: "Editor" }, true)
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
    button.click()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(new Headers(requests[0]!.headers).has("x-vitehub-comments-guest-id")).toBe(false)
    expect(readGuest()).toBeUndefined()
    expect(connectRealtimeRoom).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connectRealtimeRoom).mock.calls[0]![2]?.identity).toEqual({ id: "editor-1", name: "Editor" })
  })

  it("keeps server-identified guests on their existing identity", async () => {
    const user = { id: "external-guest", name: "Invited reviewer", guest: true }
    const { requests, shadow, button } = await compose(user, true)
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
    button.click()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(new Headers(requests[0]!.headers).has("x-vitehub-comments-guest-id")).toBe(false)
    expect(readGuest()).toBeUndefined()
    expect(connectRealtimeRoom).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connectRealtimeRoom).mock.calls[0]![2]?.identity).toEqual(user)
  })
})
