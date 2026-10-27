// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { connectRealtimeRoom } from "@vite-hub/realtime/client"

import { api } from "../src/overlay/api.ts"

import type { CommentThread } from "../src/types.ts"

vi.mock("../src/overlay/api.ts", () => ({
  api: { session: vi.fn(), threads: vi.fn(), reply: vi.fn(), remove: vi.fn(), removeComment: vi.fn(), field: vi.fn(), saveField: vi.fn() },
  readGuest: () => undefined,
  saveGuest: vi.fn(),
}))

const room = vi.hoisted(() => ({
  states: vi.fn(() => new Map<number, Record<string, unknown>>()),
  people: () => [],
  onUpdate: vi.fn(),
  onChange: vi.fn(),
  notify: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock("@vite-hub/realtime/client", () => ({ connectRealtimeRoom: vi.fn(() => room) }))

let overlay: HTMLElement
let shadow: ShadowRoot

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function thread(): CommentThread {
  const author = { id: "ada", name: "Ada" }
  const now = new Date().toISOString()
  return {
    id: "thread", page: "/", status: "open", createdBy: author, resolvedBy: null, resolvedAt: null,
    createdAt: now, updatedAt: now,
    anchor: { selector: "h1", label: "h1 Published", x: 500, y: 500, page: { x: 10, y: 10 }, viewport: { width: 1024 } },
    comments: [{ id: "root", threadId: "thread", body: "First comment", mentions: [], author, createdAt: now, editedAt: null }],
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 40))
  document.body.innerHTML = '<h1 data-content-field="settings#title">Published</h1>'
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [document.querySelector("h1")!] })
  vi.mocked(api.session).mockResolvedValue([undefined, {
    user: { id: "ada", name: "Ada" }, can: { read: true, comment: true, resolve: false }, realtime: true, content: true,
  }])
  vi.mocked(api.threads).mockImplementation(async () => [undefined, [thread()]])
  vi.mocked(api.removeComment).mockResolvedValue([undefined, null])
  vi.mocked(api.remove).mockResolvedValue([{ code: "COMMENTS_FORBIDDEN", why: "Resolve permission required" }, undefined])
  vi.mocked(api.field).mockResolvedValue([undefined, { field: "settings#title", value: "Unpublished", editable: true, digest: "draft-digest", collection: "settings", id: "settings" }])
  vi.mocked(api.saveField).mockResolvedValue([undefined, { field: "settings#title", value: "Published", digest: "saved-digest" }])
  room.states.mockReturnValue(new Map())
  if (!customElements.get("vitehub-comments")) await import("../src/overlay/index.ts")
  else document.body.append(document.createElement("vitehub-comments"))
  overlay = document.querySelector<HTMLElement>("vitehub-comments")!
  shadow = overlay.shadowRoot!
  await vi.waitFor(() => expect(shadow.querySelector(".pin-button")).not.toBeNull())
})

afterEach(() => {
  overlay.remove()
  history.replaceState(null, "", "/")
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, "elementsFromPoint")
  document.body.replaceChildren()
})

function openThread() {
  shadow.querySelector<HTMLButtonElement>(".pin-button")!.click()
}

async function startEdit() {
  const title = document.querySelector("h1")!
  const edit = shadow.querySelector<HTMLButtonElement>('[title="Edit text (E)"]')!
  if (edit.getAttribute("aria-pressed") !== "true") edit.click()
  title.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }))
  await vi.waitFor(() => expect(title.textContent).toBe("Unpublished"))
  return title
}

describe("Comments overlay", () => {
  it("uses the loaded thread permissions for replies and resolution", async () => {
    overlay.remove()
    vi.mocked(api.session).mockResolvedValue([undefined, {
      user: { id: "ada", name: "Ada" }, can: { read: true, comment: false, resolve: false }, realtime: true, content: true,
    }])
    vi.mocked(api.threads).mockResolvedValue([undefined, [{ ...thread(), can: { comment: true, resolve: true } }]])
    overlay = document.createElement("vitehub-comments")
    document.body.append(overlay)
    shadow = overlay.shadowRoot!
    await vi.waitFor(() => expect(shadow.querySelector(".pin-button")).not.toBeNull())
    openThread()
    expect(shadow.querySelector('[aria-label="Resolve"]')).not.toBeNull()
    expect(shadow.querySelector('textarea[aria-label="Reply"]')).not.toBeNull()
    expect(shadow.querySelector('[title="Edit text (E)"]')).toBeNull()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }))
    expect(document.documentElement.classList.contains("vitehub-edit-mode")).toBe(false)
    document.querySelector("h1")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(api.field).not.toHaveBeenCalled()
  })

  it("discards superseded navigation joins", async () => {
    const older = deferred<Awaited<ReturnType<typeof api.threads>>>()
    const newer = deferred<Awaited<ReturnType<typeof api.threads>>>()
    vi.mocked(api.threads).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const initialJoins = vi.mocked(connectRealtimeRoom).mock.calls.length
    history.pushState(null, "", "/older")
    await vi.waitFor(() => expect(api.threads).toHaveBeenCalledWith("/older"))
    history.pushState(null, "", "/newer")
    await vi.waitFor(() => expect(api.threads).toHaveBeenCalledWith("/newer"))
    newer.resolve([undefined, []])
    await vi.waitFor(() => expect(connectRealtimeRoom).toHaveBeenCalledTimes(initialJoins + 1))
    older.resolve([undefined, []])
    await older.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(connectRealtimeRoom).toHaveBeenCalledTimes(initialJoins + 1)
  })

  it("keeps a successful reply when an older poll finishes afterward", async () => {
    openThread()
    const pending = deferred<Awaited<ReturnType<typeof api.threads>>>()
    vi.mocked(api.threads).mockReturnValueOnce(pending.promise)
    await vi.advanceTimersByTimeAsync(30_000)
    const input = shadow.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
    input.value = "New reply"
    vi.mocked(api.reply).mockResolvedValue([undefined, { ...thread().comments[0]!, id: "reply", body: input.value }])
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))
    await vi.waitFor(() => expect(shadow.querySelector(".messages")?.textContent).toContain("New reply"))
    pending.resolve([undefined, [thread()]])
    await pending.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shadow.querySelector(".messages")?.textContent).toContain("New reply")
  })

  it("refreshes the thread panel after remote replies and resolution", async () => {
    shadow.querySelector<HTMLButtonElement>('[title="Threads on this page"]')!.click()
    const updated = thread()
    updated.comments.push({ ...updated.comments[0]!, id: "reply", body: "Remote reply" })
    vi.mocked(api.threads).mockResolvedValue([undefined, [updated]])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(shadow.querySelector(".panel")?.textContent).toContain("1 replies")
    vi.mocked(api.threads).mockResolvedValue([undefined, [{ ...updated, status: "resolved" }]])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(shadow.querySelector(".panel-item")).toBeNull()
  })

  it("submits only once while a keyboard request is pending", async () => {
    openThread()
    const pending = deferred<Awaited<ReturnType<typeof api.reply>>>()
    vi.mocked(api.reply).mockReturnValue(pending.promise)
    const input = shadow.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
    input.value = "One reply"
    const submit = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))
    submit()
    input.dispatchEvent(new Event("input"))
    submit()
    expect(api.reply).toHaveBeenCalledTimes(1)
    pending.resolve([undefined, { ...thread().comments[0]!, id: "reply", body: input.value }])
    await vi.waitFor(() => expect(shadow.querySelector(".messages")?.textContent).toContain("One reply"))
  })

  it.each(['"><image href="x" onerror="alert(document.domain)"/><!--', "#A1b2C3"])("renders remote cursor color safely: %s", (color) => {
    room.states.mockReturnValue(new Map([[1, {
      user: { id: "guest:remote", name: "Visitor", color },
      cursor: { selector: "h1", x: 500, y: 500 },
    }]]))
    openThread()
    const fill = shadow.querySelector(".cursor svg path")?.getAttribute("fill")
    expect(fill).toMatch(/^#[\da-f]{6}$/i)
    if (color === "#A1b2C3") expect(fill).toBe(color)
    expect(shadow.querySelector(".cursor image")).toBeNull()
    expect(shadow.querySelector(".cursor [onerror]")).toBeNull()
  })

  it("shows a reply immediately after polling refreshes an open composer", async () => {
    openThread()
    const input = shadow.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!
    input.value = "Reply after polling"
    input.dispatchEvent(new Event("input"))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.threads).toHaveBeenCalledTimes(2)
    expect(shadow.querySelector('textarea[aria-label="Reply"]')).toBe(input)
    const root = thread().comments[0]!
    vi.mocked(api.reply).mockResolvedValue([undefined, { ...root, id: "reply", body: input.value }])
    shadow.querySelector<HTMLButtonElement>(".card .primary")!.click()
    await vi.waitFor(() => expect(shadow.querySelector(".messages")?.textContent).toContain("Reply after polling"))
    expect(shadow.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!.value).toBe("")
  })

  it("lets an author delete their first comment through the comment endpoint", async () => {
    openThread()
    shadow.querySelector<HTMLButtonElement>('[aria-label="Delete comment"]')!.click()
    await vi.waitFor(() => expect(api.removeComment).toHaveBeenCalledWith("thread", "root"))
    expect(api.remove).not.toHaveBeenCalled()
    expect(shadow.querySelector(".pin-button")).toBeNull()
  })

  it("saves a draft edit back to the published text", async () => {
    const title = await startEdit()
    title.textContent = "Published"
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(api.saveField).toHaveBeenCalledWith({ field: "settings#title", value: "Published", ifDigest: "draft-digest" }))
  })

  it("restores published text on cancellation and leaves an unchanged draft unsaved", async () => {
    const title = await startEdit()
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(title.textContent).toBe("Published")
    await startEdit()
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(api.saveField).not.toHaveBeenCalled()
  })
})
