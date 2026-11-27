// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { commentsButton, pageTools, serveComments, startOverlay } from "./overlay-harness.ts"

import type { CommentsHandlerOptions } from "../src/runtime/handler.ts"

/** The people in the page's presence room, one entry per tab, as `room.people()` lists them. */
const room = vi.hoisted(() => ({ people: [] as { id: string, name: string, color: string, clientId: number }[], update: undefined as (() => void) | undefined, notice: undefined as ((body: unknown) => void) | undefined }))

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({
    states: () => new Map(),
    people: () => room.people,
    onUpdate: (listener: () => void) => {
      room.update = listener
      // The room says who is there once it connects.
      queueMicrotask(listener)
    },
    onChange: vi.fn(),
    onNotice: (listener: (body: unknown) => void) => {
      room.notice = listener
    },
    notify: vi.fn(),
    setLocal: vi.fn(),
    destroy: vi.fn(),
  })),
}))

const ada = { id: "ada", name: "Ada Lovelace" }

beforeEach(() => {
  room.update = undefined
  room.notice = undefined
  localStorage.clear()
  history.replaceState(null, "", "/pricing")
  document.body.innerHTML = "<main><h1>Pricing</h1></main>"
  // Ada in two tabs, and Grace in two tabs.
  room.people = [
    { id: "ada", name: "Ada Lovelace", color: "#2563eb", clientId: 1 },
    { id: "ada", name: "Ada Lovelace", color: "#2563eb", clientId: 2 },
    { id: "grace", name: "Grace Hopper", color: "#db2777", clientId: 3 },
    { id: "grace", name: "Grace Hopper", color: "#db2777", clientId: 4 },
  ]
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-comments, vitehub-pill")) element.remove()
  document.documentElement.className = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function signedIn(handler: Partial<Omit<CommentsHandlerOptions, "comments">> = {}) {
  await serveComments({ identify: () => ada, authorize: () => true }, { realtime: true, ...handler })
  const tools = pageTools()
  await startOverlay(tools)
  await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
  await vi.waitFor(() => expect(room.update).toBeDefined())
  return tools.bar
}

const faces = (bar: HTMLElement) => bar.shadowRoot!.querySelector(".people")

describe("the toolbar's faces", () => {
  it("leave out the person themselves without a GitHub sign-in, and show each other person once", async () => {
    const bar = await signedIn()
    await vi.waitFor(() => expect(faces(bar)).not.toBeNull())
    const avatars = [...faces(bar)!.querySelectorAll(".avatar")]
    expect(avatars.map(avatar => avatar.getAttribute("title"))).toEqual(["Grace Hopper · 2 tabs"])
    expect(faces(bar)!.getAttribute("aria-label")).toBe("1 other person on this page")
  })

  it("name a person with one tab without a tab count", async () => {
    room.people = room.people.slice(0, 3)
    const bar = await signedIn()
    await vi.waitFor(() => expect(faces(bar)?.querySelector(".avatar")?.getAttribute("title")).toBe("Grace Hopper"))
  })

  it("stay out of the toolbar with `presence: false`", async () => {
    const bar = await signedIn({ presence: false })
    room.update!()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(faces(bar)).toBeNull()
  })
})

describe("a server write", () => {
  it("reaches a joined page through a room notice", async () => {
    const server = await serveComments({ identify: () => ada, authorize: () => true }, { realtime: true })
    const tools = pageTools()
    document.documentElement.append(tools.pill)
    await startOverlay(tools)
    await vi.waitFor(() => expect(room.notice).toBeDefined())
    const reads = () => server.requests.filter(request => request.path.includes("/threads?")).length
    const before = reads()
    await server.comments.create({ page: "/pricing", anchor: { kind: "element", selector: "h1", x: 500, y: 500 }, body: "From the MCP", author: ada })
    expect(commentsButton(tools.bar)?.getAttribute("aria-label")).toBe("Comments")
    room.notice!({ type: "comments" })
    room.notice!({ type: "comments" })
    await vi.waitFor(() => expect(reads()).toBe(before + 1))
    await vi.waitFor(() => expect(commentsButton(tools.bar)?.getAttribute("aria-label")).toBe("Comments, 1 open"))
  })
})
