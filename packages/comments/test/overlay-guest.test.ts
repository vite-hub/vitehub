// @vitest-environment happy-dom
import { connectRealtimeRoom } from "@vite-hub/realtime/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readGuest, saveGuest } from "../src/overlay/api.ts"
import { pageTools, press, serveComments, startOverlay, tool, type } from "./overlay-harness.ts"

import type { CommentsUser } from "../src/types.ts"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ states: () => new Map(), people: () => [], onUpdate: vi.fn(), onChange: vi.fn(), notify: vi.fn(), setLocal: vi.fn(), destroy: vi.fn() })),
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  history.replaceState(null, "", "/")
  document.body.innerHTML = "<h1>Page title</h1>"
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-comments, vitehub-pill")) element.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A site with presence, where `user` is who the server says, and anyone may comment. */
async function join(user: CommentsUser | null) {
  await serveComments({ identify: () => user, authorize: () => true }, { realtime: true })
  const tools = pageTools()
  const { shadow } = await startOverlay(tools)
  await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalledTimes(1))
  return { ...tools, shadow }
}

const identity = (call: number) => vi.mocked(connectRealtimeRoom).mock.calls[call]![2]?.identity

describe("guests of the Comments overlay", () => {
  it("lets Realtime pick an identity for a guest without a name", async () => {
    await join(null)
    expect(identity(0)).toBeUndefined()
  })

  it("rejoins the room with the guest's name once they give it", async () => {
    const { bar, shadow } = await join(null)
    const room = vi.mocked(connectRealtimeRoom).mock.results[0]!.value
    tool(bar, "Comment on the page (C)")!.click()
    await vi.waitFor(() => expect(shadow.querySelector('input[aria-label="Your name"]')).not.toBeNull())
    const name = shadow.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!
    // An empty name keeps the card open.
    name.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(readGuest()).toBeUndefined()
    expect(shadow.activeElement).toBe(name)
    await type(name, "Ana García")
    name.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    const guest = readGuest()!
    await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalledTimes(2))
    expect(room.destroy).toHaveBeenCalledTimes(1)
    expect(identity(1)).toEqual({ id: `guest:${guest.id}`, name: "Ana García (guest)" })
  })

  it("uses the name this browser saved on an earlier page", async () => {
    const guest = saveGuest("Ana García")
    const { bar, shadow } = await join(null)
    expect(identity(0)).toEqual({ id: `guest:${guest.id}`, name: "Ana García (guest)" })
    tool(bar, "Comment on the page (C)")!.click()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
  })

  it.each([
    { id: "editor-1", name: "Editor" },
    { id: "external-guest", name: "Invited reviewer", guest: true },
  ])("keeps the identity that the server gave: %j", async (user) => {
    const { bar, shadow } = await join(user)
    expect(identity(0)).toEqual(user)
    tool(bar, "Comment on the page (C)")!.click()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
    expect(readGuest()).toBeUndefined()
  })
})

describe("a first-time guest who selected text", () => {
  it("comments on the quote after giving a name", async () => {
    const { requests } = await serveComments({ identify: () => null, authorize: () => true }, { realtime: true })
    const { shadow } = await startOverlay(pageTools())
    await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalledTimes(1))
    const range = document.createRange()
    range.setStart(document.querySelector("h1")!.firstChild!, 0)
    range.setEnd(document.querySelector("h1")!.firstChild!, 4)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    press(document.body, "c")
    await vi.waitFor(() => expect(shadow.querySelector('input[aria-label="Your name"]')).not.toBeNull())
    // In a browser, the focus in the name field takes the selection away from the page.
    getSelection()!.removeAllRanges()
    const name = shadow.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!
    await type(name, "Ana")
    name.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(shadow.querySelector('textarea[aria-label="Comment"]')).not.toBeNull())
    const input = shadow.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!
    await type(input, "Shorter title")
    press(input, "Enter")
    await vi.waitFor(() => expect(requests.some(request => request.method === "POST" && request.path.endsWith("/threads"))).toBe(true))
    const sent = requests.find(request => request.method === "POST" && request.path.endsWith("/threads"))!
    expect(sent.body).toMatchObject({ anchor: { kind: "text", exact: "Page" } })
  })
})
