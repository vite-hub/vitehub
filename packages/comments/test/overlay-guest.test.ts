// @vitest-environment happy-dom
import { connectRealtimeRoom } from "@vite-hub/realtime/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readGuest, saveGuest } from "../src/overlay/api.ts"
import { pageTools, serveComments, startOverlay, tool, type } from "./overlay-harness.ts"

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
    tool(bar, "Comment (C)")!.click()
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
    tool(bar, "Comment (C)")!.click()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
  })

  it.each([
    { id: "editor-1", name: "Editor" },
    { id: "external-guest", name: "Invited reviewer", guest: true },
  ])("keeps the identity that the server gave: %j", async (user) => {
    const { bar, shadow } = await join(user)
    expect(identity(0)).toEqual(user)
    tool(bar, "Comment (C)")!.click()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
    expect(readGuest()).toBeUndefined()
  })
})
