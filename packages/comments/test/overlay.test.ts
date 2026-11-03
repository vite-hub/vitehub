// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readGuest, saveGuest } from "../src/overlay/api.ts"
import { clickPage, pageTools, press, serveComments, startOverlay, tool, type } from "./overlay-harness.ts"

import type { CommentsUser, ElementAnchor } from "../src/types.ts"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ states: () => new Map(), people: () => [], onUpdate: vi.fn(), onChange: vi.fn(), notify: vi.fn(), setLocal: vi.fn(), destroy: vi.fn() })),
}))

const ada = { id: "ada", name: "Ada Lovelace" }
const grace = { id: "grace", name: "Grace Hopper" }
const anchor = { kind: "element", selector: "main > h1", x: 500, y: 500 } satisfies ElementAnchor

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  history.replaceState(null, "", "/pricing")
  document.body.innerHTML = '<main><h1 data-content-field="pricing#title">Pricing</h1><p>Plans</p></main>'
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 40))
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [document.querySelector("h1")!] })
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-comments, vitehub-pill")) element.remove()
  document.documentElement.className = ""
  Reflect.deleteProperty(document, "elementsFromPoint")
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A site where `user` is signed in, and Ada and Grace may be mentioned. */
async function site(user: CommentsUser | null = ada, options: Parameters<typeof serveComments>[0] = {}, before?: (comments: Awaited<ReturnType<typeof serveComments>>["comments"]) => Promise<unknown>) {
  const server = await serveComments({
    identify: () => user,
    people: { search: async () => [ada, grace], byIds: async ids => [ada, grace].filter(person => ids.includes(person.id)) },
    ...options,
  })
  await before?.(server.comments)
  const tools = pageTools()
  const { shadow, overlay, cleanup } = await startOverlay(tools)
  await vi.waitFor(() => expect(tool(tools.bar, "Comments on this page")).not.toBeNull())
  return { ...server, ...tools, shadow, overlay, cleanup }
}

const composer = (root: ParentNode, label: string) => root.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)

describe("the Comments overlay on the comment parts", () => {
  it("loads the toolbar for a page allowed by a subject-aware policy", async () => {
    const { bar, requests } = await site(ada, { authorize: ({ subject }) => subject?.id === "/pricing" })
    expect(bar.hidden).toBe(false)
    expect(requests.some(request => request.path === "/api/_vitehub/comments/session?page=%2Fpricing")).toBe(true)
  })

  it.each(["layer", "panel"])("keeps mention targets through the %s and API", async (surface) => {
    let threadId: string | undefined
    const { shadow, bar, panel, comments } = await site(ada, {
      canMention: ({ person, subject, thread }) => person.id === "grace" && subject?.id === "/pricing" && (threadId ? thread?.id === threadId : !thread),
    })
    let root: ShadowRoot
    if (surface === "layer") {
      press(document.body, "c")
      await clickPage(shadow, 60, 20)
      root = shadow
    }
    else {
      tool(bar, "Comments on this page")!.click()
      root = panel()!
    }
    const label = "Comment"
    await vi.waitFor(() => expect(composer(root, label)).not.toBeNull())
    const input = composer(root, label)!
    await type(input, "@gra")
    await vi.waitFor(() => expect(root.querySelector('[role="option"]')?.textContent).toContain("Grace Hopper"))
    root.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    await vi.waitFor(() => expect(input.value).toBe("@Grace Hopper "))
    press(input, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    const created = (await comments.list())[1]![0]!
    threadId = created.id
    expect(created.messages[0]!.mentions).toEqual(["grace"])
    if (surface === "layer") {
      await vi.waitFor(() => expect(root.querySelector('[data-slot="comment-pin"]')).not.toBeNull())
      root.querySelector<HTMLButtonElement>('[data-slot="comment-pin"]')!.click()
    }
    else {
      await vi.waitFor(() => expect(root.querySelector('[data-slot="comment-panel-item"]')).not.toBeNull())
      root.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
    }
    await vi.waitFor(() => expect(composer(root, "Reply")).not.toBeNull())
    const reply = composer(root, "Reply")!
    await type(reply, "@gra")
    await vi.waitFor(() => expect(root.querySelector('[role="option"]')?.textContent).toContain("Grace Hopper"))
    root.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    await vi.waitFor(() => expect(reply.value).toBe("@Grace Hopper "))
    press(reply, "Enter")
    await vi.waitFor(async () => expect((await comments.get(created.id))[1]!.messages).toHaveLength(2))
    expect((await comments.get(created.id))[1]!.messages[1]!.mentions).toEqual(["grace"])
  })

  it.each(["layer", "panel"])("protects an attachment-only %s draft on exit and navigation", async (surface) => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal("confirm", confirm)
    const { shadow, bar, panel, context } = await site()
    let root: ShadowRoot
    if (surface === "layer") {
      press(document.body, "c")
      await clickPage(shadow, 60, 20)
      root = shadow
    }
    else {
      tool(bar, "Comments on this page")!.click()
      root = panel()!
    }
    await vi.waitFor(() => expect(root.querySelector('input[type="file"]')).not.toBeNull())
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "draft.png", { type: "image/png" })] })
    input.dispatchEvent(new Event("change", { bubbles: true }))
    await vi.waitFor(() => expect(root.textContent).toContain("draft.png"))
    const beforeExit = (context.beforeExit.mock.calls as unknown as Array<[() => boolean]>)[0]![0]
    expect(beforeExit()).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    confirm.mockClear()
    history.pushState(null, "", "/next")
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(root.textContent).toContain("draft.png")
    confirm.mockReturnValue(true)
    history.replaceState(null, "", "/next")
    await vi.waitFor(() => expect(root.textContent).not.toContain("draft.png"))
  })

  it("comments on an element with the overlay's anchor hints and the page context", async () => {
    const { shadow, bar, comments } = await site()
    press(document.body, "c")
    await vi.waitFor(() => expect(tool(bar, "Comment (C)")!.getAttribute("aria-pressed")).toBe("true"))
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(true)
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    const input = composer(shadow, "Comment")!
    await type(input, "Make the title shorter")
    press(input, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    const [thread] = (await comments.list())[1]!
    expect(thread!.messages[0]!.body).toBe("Make the title shorter")
    expect(thread!.subject).toEqual({ kind: "page", id: "/pricing" })
    expect(thread!.anchor).toMatchObject({ kind: "element", field: "pricing#title", label: "h1 Pricing", x: 250, y: 250 })
    expect(thread!.context).toMatchObject({ url: `${location.origin}/pricing`, element: { tag: "h1", name: "Pricing" } })
    await vi.waitFor(() => expect(shadow.querySelector(`[data-slot="comment-pin"][data-thread-id="${thread!.id}"]`)).not.toBeNull())
  })

  it("replies with an @mention, shows the chip, and resolves the thread", async () => {
    let created: { id: string } | undefined
    const { shadow, comments, requests } = await site(ada, {}, async (comments) => {
      created = (await comments.create({ page: "/pricing", anchor, body: "First comment", author: ada }))[1]
    })
    await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-pin"]')).not.toBeNull())
    shadow.querySelector<HTMLButtonElement>('[data-slot="comment-pin"]')!.click()
    await vi.waitFor(() => expect(composer(shadow, "Reply")).not.toBeNull())
    const input = composer(shadow, "Reply")!
    await type(input, "@gra")
    await vi.waitFor(() => expect(shadow.querySelector('[role="option"]')).not.toBeNull())
    expect(shadow.querySelector('[role="option"]')!.textContent).toContain("Grace Hopper")
    shadow.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    await vi.waitFor(() => expect(input.value).toBe("@Grace Hopper "))
    await type(input, "@Grace Hopper can you check?")
    press(input, "Enter")
    await vi.waitFor(async () => expect((await comments.get(created!.id))[1]!.messages).toHaveLength(2))
    const reply = (await comments.get(created!.id))[1]!.messages[1]!
    expect(reply).toMatchObject({ body: "@Grace Hopper can you check?", mentions: ["grace"] })
    expect(requests.find(request => request.path.endsWith("/comments") && request.method === "POST")?.body).toMatchObject({ mentions: ["grace"] })
    await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-mention"]')?.textContent).toBe("@Grace Hopper"))

    shadow.querySelector<HTMLButtonElement>('[aria-label="Resolve"]')!.click()
    await vi.waitFor(async () => expect((await comments.get(created!.id))[1]!.status).toBe("resolved"))
    await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-pin"]')).toBeNull())
  })

  it("asks a guest for a name before comment mode, then sends it in the guest headers", async () => {
    const { shadow, bar, comments, requests } = await site(null, { authorize: () => true })
    tool(bar, "Comment (C)")!.click()
    await vi.waitFor(() => expect(shadow.querySelector('input[aria-label="Your name"]')).not.toBeNull())
    expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).toBeNull()
    const name = shadow.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!
    await type(name, "  Ana García ")
    name.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(readGuest()?.name).toBe("Ana García")
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    await type(composer(shadow, "Comment")!, "From a guest")
    press(composer(shadow, "Comment")!, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    const sent = requests.find(request => request.method === "POST" && request.path.endsWith("/threads"))!
    expect(sent.headers.get("x-vitehub-comments-guest-id")).toBe(readGuest()!.id)
    expect(decodeURIComponent(sent.headers.get("x-vitehub-comments-guest-name")!)).toBe("Ana García")
    expect((await comments.list())[1]![0]!.author).toEqual({ id: `guest:${readGuest()!.id}`, name: "Ana García", guest: true })
  })

  it("keeps a signed-in person on their account, without guest headers", async () => {
    saveGuest("Old guest name")
    const { shadow, comments, requests } = await site()
    press(document.body, "c")
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    expect(shadow.querySelector('input[aria-label="Your name"]')).toBeNull()
    await type(composer(shadow, "Comment")!, "Signed in")
    press(composer(shadow, "Comment")!, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    expect((await comments.list())[1]![0]!.author).toEqual(ada)
    const sent = requests.find(request => request.method === "POST" && request.path.endsWith("/threads"))!
    // The server prefers the account; the headers of an earlier guest session change nothing.
    expect(sent.headers.get("x-vitehub-comments-guest-id")).toBe(readGuest()!.id)
  })

  it("opens the thread of a ?comment=<n> link, also a resolved one", async () => {
    const server = await serveComments({ identify: () => ada })
    const [, first] = await server.comments.create({ page: "/pricing", anchor, body: "First", author: ada })
    const [, second] = await server.comments.create({ page: "/pricing", anchor: { ...anchor, x: 100 }, body: "Second, resolved", author: ada })
    await server.comments.resolve(second!.id, { by: ada })
    history.replaceState(null, "", `/pricing?comment=${second!.n}`)
    const tools = pageTools()
    const { shadow } = await startOverlay(tools)
    await vi.waitFor(() => expect(shadow.querySelector(`[aria-label="Comment ${second!.n}"][data-slot="comment-thread"]`)).not.toBeNull())
    expect(shadow.querySelector('[data-slot="comment-thread"]')!.textContent).toContain("Second, resolved")
    expect(first!.n).not.toBe(second!.n)
  })

  it("uploads files through comments.upload and sends their keys", async () => {
    const stored: Array<{ name: string, type: string, size: number }> = []
    const { shadow, comments, requests } = await site(ada, {
      storeAttachment: (file) => {
        stored.push({ name: file.name, type: file.type, size: file.size })
        return `files/${file.name}`
      },
    })
    press(document.body, "c")
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    const file = new File(["png bytes"], "shot.png", { type: "image/png" })
    const picker = shadow.querySelector<HTMLInputElement>('[data-slot="comment-layer-popover"] input[type="file"]')!
    Object.defineProperty(picker, "files", { configurable: true, value: [file] })
    picker.dispatchEvent(new Event("change", { bubbles: true }))
    await type(composer(shadow, "Comment")!, "With a screenshot")
    await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-layer-popover"] [data-slot="attachment"]')).not.toBeNull())
    press(composer(shadow, "Comment")!, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    expect(stored).toEqual([{ name: "shot.png", type: "image/png", size: 9 }])
    expect(requests.find(request => request.path.endsWith("/uploads"))?.body).toMatchObject({ name: "shot.png", type: "image/png", page: "/pricing" })
    expect((await comments.list())[1]![0]!.messages[0]!.attachments).toEqual(["files/shot.png"])
  })

  it("lists the page's threads in the pill's window with Open and Resolved", async () => {
    const server = await serveComments({ identify: () => ada })
    await server.comments.create({ page: "/pricing", anchor, body: "Open one", author: ada })
    const [, done] = await server.comments.create({ page: "/pricing", anchor, body: "Done one", author: ada })
    await server.comments.resolve(done!.id, { by: ada })
    const tools = pageTools()
    const { shadow } = await startOverlay(tools)
    await vi.waitFor(() => expect(tool(tools.bar, "Comments on this page")!.textContent).toBe("1"))
    tool(tools.bar, "Comments on this page")!.click()
    const panel = tools.panel()!
    await vi.waitFor(() => expect(panel.querySelectorAll('[data-slot="comment-panel-item"]')).toHaveLength(1))
    expect(panel.textContent).toContain("Open one")
    panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-filter"][data-state="off"]')!.click()
    await vi.waitFor(() => expect(panel.textContent).toContain("Done one"))
    // Resolved pins show on the page while the list shows resolved threads.
    await vi.waitFor(() => expect(shadow.querySelectorAll('[data-slot="comment-pin"][data-status="resolved"]')).toHaveLength(1))
  })

  it("shows the Sign in with GitHub prompt to a person who may not read", async () => {
    await serveComments({ identify: () => null, authorize: () => false })
    const tools = pageTools()
    const { shadow } = await startOverlay(tools)
    await vi.waitFor(() => expect(shadow.querySelector(".toast")).not.toBeNull())
    expect(tools.bar.hidden).toBe(true)
    expect(shadow.querySelector(".toast")!.textContent).toContain("Comments are only for the site's team")
  })
})
