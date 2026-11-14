// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defineCommentSubject } from "../src/operations-core/define.ts"
import { api, readGuest, saveGuest } from "../src/overlay/api.ts"
import { clickPage, commentsButton, openList, pageTools, press, serveComments, startOverlay, tool, type } from "./overlay-harness.ts"

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
  await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
  return { ...server, ...tools, shadow, overlay, cleanup }
}

const composer = (root: ParentNode, label: string) => root.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)

describe("the Comments overlay on the comment parts", () => {
  it.each(["layer", "panel"])("links stored attachments in the %s", async (surface) => {
    const { shadow, bar, panel } = await site(ada, {}, async (comments) => {
      await comments.create({ page: "/pricing", anchor, body: "Read this file", attachments: ["files/guide.pdf"], author: ada })
    })
    let root: ShadowRoot
    if (surface === "layer") {
      await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-pin"]')).not.toBeNull())
      shadow.querySelector<HTMLButtonElement>('[data-slot="comment-pin"]')!.click()
      root = shadow
    }
    else {
      await openList(bar)
      root = panel()!
      await vi.waitFor(() => expect(root.querySelector('[data-slot="comment-panel-item"]')).not.toBeNull())
      root.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
    }
    await vi.waitFor(() => expect(root.querySelector('a[href="/api/_vitehub/comments/attachments/files/guide.pdf"]')).not.toBeNull())
  })

  it("loads the toolbar for a page allowed by a subject-aware policy", async () => {
    const { bar, requests } = await site(ada, { authorize: ({ subject }) => subject?.id === "/pricing" })
    expect(bar.hidden).toBe(false)
    expect(requests.some(request => request.path === "/api/_vitehub/comments/session?page=%2Fpricing")).toBe(true)
  })

  it.each(["layer", "panel"])("uses thread permissions in the %s even when page permissions differ", async (surface) => {
    let threadId: string | undefined
    const { shadow, bar, panel } = await site(ada, {
      authorize: ({ action, thread }) => action === "read" || Boolean(thread),
    }, async (comments) => {
      threadId = (await comments.create({ page: "/pricing", anchor, body: "Thread grant", author: grace }))[1]!.id
    })
    expect(tool(bar, "Comment on the page (C)")).toBeNull()
    let root: ShadowRoot
    if (surface === "layer") {
      await vi.waitFor(() => expect(shadow.querySelector(`[data-thread-id="${threadId}"]`)).not.toBeNull())
      shadow.querySelector<HTMLButtonElement>('[data-slot="comment-pin"]')!.click()
      root = shadow
    }
    else {
      await openList(bar)
      root = panel()!
      await vi.waitFor(() => expect(root.querySelector('[data-slot="comment-panel-item"]')).not.toBeNull())
      expect(composer(root, "Comment")).toBeNull()
      root.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
    }
    await vi.waitFor(() => expect(composer(root, "Reply")).not.toBeNull())
    expect(root.querySelector('[aria-label="Resolve"]')).not.toBeNull()
    expect(root.querySelector('[aria-label="Delete"]')).not.toBeNull()
  })

  it.each(["layer", "panel"])("hides thread-denied controls in the %s", async (surface) => {
    const { shadow, bar, panel } = await site(ada, {
      authorize: ({ action, thread }) => action === "read" || !thread,
    }, async (comments) => {
      await comments.create({ page: "/pricing", anchor, body: "Read only thread", author: grace })
    })
    let root: ShadowRoot
    if (surface === "layer") {
      await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-pin"]')).not.toBeNull())
      shadow.querySelector<HTMLButtonElement>('[data-slot="comment-pin"]')!.click()
      root = shadow
    }
    else {
      await openList(bar)
      root = panel()!
      await vi.waitFor(() => expect(root.querySelector('[data-slot="comment-panel-item"]')).not.toBeNull())
      root.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
    }
    await vi.waitFor(() => expect(root.querySelector('[data-slot="comment-thread"]')).not.toBeNull())
    expect(composer(root, "Reply")).toBeNull()
    expect(root.querySelector('[aria-label="Resolve"]')).toBeNull()
    expect(root.querySelector('[aria-label="Delete"]')).toBeNull()
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
      await openList(bar)
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
      await openList(bar)
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
    await vi.waitFor(() => expect(commentsButton(bar)!.getAttribute("aria-pressed")).toBe("true"))
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

  describe("deleting other people's messages", () => {
    let created: { id: string } | undefined
    const seed = async (comments: Awaited<ReturnType<typeof serveComments>>["comments"]) => {
      created = (await comments.create({ page: "/pricing", anchor, body: "Ada's comment", author: ada }))[1]
      await comments.reply(created!.id, { body: "Grace's reply", author: grace })
    }
    const deletes = (shadow: ShadowRoot) => [...shadow.querySelectorAll('[data-slot="comment-reply"]')].map(reply => reply.querySelector('[aria-label="Delete"]') !== null)
    const open = async (shadow: ShadowRoot) => {
      await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-pin"]')).not.toBeNull())
      shadow.querySelector<HTMLButtonElement>('[data-slot="comment-pin"]')!.click()
      await vi.waitFor(() => expect(shadow.querySelectorAll('[data-slot="comment-reply"]')).toHaveLength(2))
    }

    it("shows a member Delete only on their own reply, since Ada's first message would take Grace's reply with it", async () => {
      const { shadow } = await site(grace, { authorize: ({ action }) => action !== "delete" }, seed)
      await open(shadow)
      expect(deletes(shadow)).toEqual([false, true])
    })

    it("lets a moderator with `delete` delete anyone's message", async () => {
      const { shadow, comments } = await site(ada, { authorize: () => true }, seed)
      await open(shadow)
      await vi.waitFor(() => expect(deletes(shadow)).toEqual([true, true]))
      shadow.querySelectorAll<HTMLButtonElement>('[data-slot="comment-reply"] [aria-label="Delete"]')[1]!.click()
      await vi.waitFor(async () => expect((await comments.get(created!.id))[1]!.messages.map(message => message.body)).toEqual(["Ada's comment"]))
    })

    it("refuses it on the server without `delete`", async () => {
      const { comments, fetch } = await serveComments({ identify: () => grace, authorize: ({ action }) => action !== "delete" })
      const [, thread] = await comments.create({ page: "/pricing", anchor, body: "Ada's comment", author: ada })
      const response = await fetch(`/api/_vitehub/comments/threads/${thread!.id}/comments/${thread!.messages[0]!.id}`, { method: "DELETE" })
      expect(response.status).toBe(403)
      expect((await comments.get(thread!.id))[1]!.messages).toHaveLength(1)
    })
  })

  it("asks a guest for a name before comment mode, then sends it in the guest headers", async () => {
    const { shadow, bar, comments, requests } = await site(null, { authorize: () => true })
    tool(bar, "Comment on the page (C)")!.click()
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
    expect(composer(shadow, "Reply")).toBeNull()
    expect(first!.n).not.toBe(second!.n)
    // The link has done its work: the address drops it, and the thread stays open.
    await vi.waitFor(() => expect(location.pathname + location.search).toBe("/pricing"))
    expect(shadow.querySelector(`[aria-label="Comment ${second!.n}"][data-slot="comment-thread"]`)).not.toBeNull()
  })

  it("keeps the ?comment=<n> link and the other query in the address until the threads load", async () => {
    const server = await serveComments({ identify: () => ada })
    const [, thread] = await server.comments.create({ page: "/pricing", anchor, body: "Linked", author: ada })
    let answer!: () => void
    const answered = new Promise<void>(resolve => (answer = resolve))
    const list = server.fetch.getMockImplementation()!
    let held = false
    server.fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input), location.href).pathname.endsWith("/threads")) {
        held = true
        await answered
      }
      return await list(input, init)
    })
    history.replaceState(null, "", `/pricing?plan=pro&comment=${thread!.n}#faq`)
    const { shadow } = await startOverlay(pageTools({ linked: true }))
    await vi.waitFor(() => expect(held).toBe(true))
    expect(location.search).toBe(`?plan=pro&comment=${thread!.n}`)
    answer()
    await vi.waitFor(() => expect(shadow.querySelector(`[aria-label="Comment ${thread!.n}"][data-slot="comment-thread"]`)).not.toBeNull())
    await vi.waitFor(() => expect(location.pathname + location.search + location.hash).toBe("/pricing?plan=pro#faq"))
    // The thread opens, not comment mode.
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)
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
    expect(requests.find(request => request.path.endsWith("/attachments"))?.body).toMatchObject({ name: "shot.png", type: "image/png", subject: { kind: "page", id: "/pricing" } })
    expect((await comments.list())[1]![0]!.messages[0]!.attachments).toEqual(["files/shot.png"])
  })

  it("comments and uploads on the subject that the server maps the page to, also after navigation", async () => {
    const { shadow, comments, requests } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3), revision: 2 } : url.pathname === "/pricing" ? { kind: "drop", id: "pricing" } : undefined,
      storeAttachment: file => `files/${file.name}`,
    })
    press(document.body, "c")
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    const picker = shadow.querySelector<HTMLInputElement>('[data-slot="comment-layer-popover"] input[type="file"]')!
    Object.defineProperty(picker, "files", { configurable: true, value: [new File(["png"], "shot.png", { type: "image/png" })] })
    picker.dispatchEvent(new Event("change", { bubbles: true }))
    await type(composer(shadow, "Comment")!, "On the drop")
    await vi.waitFor(() => expect(shadow.querySelector('[data-slot="comment-layer-popover"] [data-slot="attachment"]')).not.toBeNull())
    press(composer(shadow, "Comment")!, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    expect((await comments.list())[1]![0]!.subject).toEqual({ kind: "drop", id: "pricing" })
    expect(requests.find(request => request.path.endsWith("/attachments"))?.body).toMatchObject({ subject: { kind: "drop", id: "pricing" } })

    history.pushState(null, "", "/d/abc")
    await vi.waitFor(() => expect(requests.some(request => request.path.includes("subjectKind=drop&subjectId=abc"))).toBe(true))
    history.pushState(null, "", "/plain")
    await vi.waitFor(() => expect(requests.some(request => request.path.includes("subjectKind=page&subjectId=%2Fplain"))).toBe(true))
  })

  it("follows the permissions of the new page after a navigation", async () => {
    const { bar } = await site(ada, { authorize: ({ action, subject }) => action === "read" || subject?.id === "/pricing" })
    await vi.waitFor(() => expect(tool(bar, "Comment on the page (C)")).not.toBeNull())
    history.pushState(null, "", "/docs")
    await vi.waitFor(() => expect(tool(bar, "Comment on the page (C)")).toBeNull())
    press(document.body, "c")
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)
    history.pushState(null, "", "/pricing")
    await vi.waitFor(() => expect(tool(bar, "Comment on the page (C)")).not.toBeNull())
  })

  it("starts a whole-page thread from the list on the revision that the server maps the page to", async () => {
    const { bar, panel, comments } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: () => ({ kind: "drop", id: "pricing", revision: 4 }),
    })
    await openList(bar)
    await vi.waitFor(() => expect(panel()?.querySelector("textarea")).not.toBeNull())
    const box = panel()!.querySelector("textarea")!
    await type(box, "On the whole drop")
    press(box, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    expect((await comments.list())[1]![0]).toMatchObject({ subject: { kind: "drop", id: "pricing" }, anchor: { kind: "page" }, revision: 4 })
  })

  it("starts a thread on the revision that the person saw, when a new one comes out while they type", async () => {
    let latest = 4
    const { bar, panel, comments } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: () => ({ kind: "drop", id: "pricing", revision: latest }),
    })
    latest = 5
    await openList(bar)
    await vi.waitFor(() => expect(panel()?.querySelector("textarea")).not.toBeNull())
    const box = panel()!.querySelector("textarea")!
    await type(box, "On version 4")
    press(box, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    expect((await comments.list())[1]![0]).toMatchObject({ subject: { kind: "drop", id: "pricing" }, revision: 4 })
  })

  it("keeps comments paused and offers Retry when the session of the new page fails", async () => {
    const session = api.session
    let fail = true
    vi.spyOn(api, "session").mockImplementation(async (page) => {
      if (page === "/d/abc" && fail) return [{ code: "COMMENTS_UNAVAILABLE", why: "The server did not answer." }, undefined] as unknown as Awaited<ReturnType<typeof session>>
      return await session(page)
    })
    const { shadow, comments } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3) } : undefined,
    })
    press(document.body, "c")
    history.pushState(null, "", "/d/abc")
    await vi.waitFor(() => expect(shadow.querySelector(".toast")?.textContent).toContain("Comments are paused"))
    // No comment starts on a guessed subject.
    expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).toBeNull()
    fail = false
    const retry = [...shadow.querySelectorAll<HTMLButtonElement>(".toast button")].find(button => button.textContent === "Retry")!
    retry.click()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(shadow.querySelector(".toast")).toBeNull()
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    await type(composer(shadow, "Comment")!, "On abc")
    press(composer(shadow, "Comment")!, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    expect((await comments.list())[1]![0]!.subject).toEqual({ kind: "drop", id: "abc" })
  })

  it("ignores the Retry of a page the person left, and drops its toast", async () => {
    const session = api.session
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(api, "session").mockImplementation(async (page) => {
      if (page === "/d/abc") return [{ code: "COMMENTS_UNAVAILABLE", why: "The server did not answer." }, undefined] as unknown as Awaited<ReturnType<typeof session>>
      if (page === "/d/next") await held
      return await session(page)
    })
    const { shadow } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3) } : undefined,
    })
    press(document.body, "c")
    history.pushState(null, "", "/d/abc")
    await vi.waitFor(() => expect(shadow.querySelector(".toast")?.textContent).toContain("Comments are paused"))
    const retry = [...shadow.querySelectorAll<HTMLButtonElement>(".toast button")].find(button => button.textContent === "Retry")!
    history.pushState(null, "", "/d/next")
    await vi.waitFor(() => expect(vi.mocked(api.session)).toHaveBeenCalledWith("/d/next"))
    await vi.waitFor(() => expect(shadow.querySelector(".toast")).toBeNull())
    // A click that was already on its way when the toast went.
    retry.click()
    const calls = vi.mocked(api.session).mock.calls.length
    release()
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(vi.mocked(api.session).mock.calls.length).toBe(calls)
  })

  it("uses only the answer of the latest navigation", async () => {
    const session = api.session
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    vi.spyOn(api, "session").mockImplementation(async (page) => {
      // The first answer for /d/abc comes last and is out of date.
      if (page === "/d/abc" && calls++ === 0) {
        await held
        const [error, answer] = await session(page)
        return (error ? [error, undefined] : [undefined, { ...answer, subject: { kind: "drop", id: "stale" } }]) as Awaited<ReturnType<typeof session>>
      }
      return await session(page)
    })
    const { requests } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3) } : undefined,
    })
    // Each navigation asks the session route before the next one starts.
    for (const path of ["/d/abc", "/d/other", "/d/abc"]) {
      const before = vi.mocked(api.session).mock.calls.length
      history.pushState(null, "", path)
      await vi.waitFor(() => expect(vi.mocked(api.session).mock.calls.length).toBe(before + 1))
    }
    await vi.waitFor(() => expect(requests.some(request => request.path.includes("subjectKind=drop&subjectId=abc"))).toBe(true))
    release()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(requests.some(request => request.path.includes("subjectId=stale"))).toBe(false)
  })

  it("discards the draft after the person agrees, also when the new page has the same subject", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    const { shadow } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: () => ({ kind: "drop", id: "one" }),
    })
    press(document.body, "c")
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    await type(composer(shadow, "Comment")!, "Half a thought")
    history.pushState(null, "", "/pricing/annual")
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    expect(composer(shadow, "Comment")).toBeNull()
  })

  it("lets the Comment button turn comment mode off while the subject of the new page loads", async () => {
    let answer!: () => void
    const answered = new Promise<void>((resolve) => { answer = resolve })
    const session = api.session
    vi.spyOn(api, "session").mockImplementation(async (page) => {
      if (page === "/d/abc") await answered
      return await session(page)
    })
    const { bar, shadow } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3) } : undefined,
    })
    press(document.body, "c")
    await vi.waitFor(() => expect(commentsButton(bar)!.getAttribute("aria-pressed")).toBe("true"))
    history.pushState(null, "", "/d/abc")
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).toBeNull())
    // Comment mode waits for the subject, and the button still shows it on.
    expect(commentsButton(bar)!.getAttribute("aria-pressed")).toBe("true")
    commentsButton(bar)!.click()
    await vi.waitFor(() => expect(commentsButton(bar)!.getAttribute("aria-pressed")).toBe("false"))
    answer()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).toBeNull()
  })

  it("starts no comment and lists no threads until the server names the subject of the new page", async () => {
    let answer!: () => void
    const answered = new Promise<void>((resolve) => { answer = resolve })
    const session = api.session
    vi.spyOn(api, "session").mockImplementation(async (page) => {
      if (page === "/d/abc") await answered
      return await session(page)
    })
    const { shadow, comments, requests } = await site(ada, {
      subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3) } : undefined,
    })
    press(document.body, "c")
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).not.toBeNull())
    history.pushState(null, "", "/d/abc")
    await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']")).toBeNull())
    press(document.querySelector("h1")!, "Enter")
    // C turns the waiting comment mode off and on again, and starts nothing.
    press(document.body, "c")
    press(document.body, "c")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(composer(shadow, "Comment")).toBeNull()
    answer()
    // Comment mode comes back on the drop, and a comment typed now stays.
    await clickPage(shadow, 60, 20)
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    await type(composer(shadow, "Comment")!, "On abc")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(composer(shadow, "Comment")!.value).toBe("On abc")
    press(composer(shadow, "Comment")!, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    expect((await comments.list())[1]![0]!.subject).toEqual({ kind: "drop", id: "abc" })
    expect(requests.some(request => request.path.includes("subjectId=%2Fd%2Fabc"))).toBe(false)
  })

  it("lists the page's threads in the pill's window with Open and Resolved", async () => {
    const server = await serveComments({ identify: () => ada })
    await server.comments.create({ page: "/pricing", anchor, body: "Open one", author: ada })
    const [, done] = await server.comments.create({ page: "/pricing", anchor, body: "Done one", author: ada })
    await server.comments.resolve(done!.id, { by: ada })
    const tools = pageTools()
    const { shadow } = await startOverlay(tools)
    await vi.waitFor(() => expect(commentsButton(tools.bar)?.getAttribute("aria-label")).toBe("Comments, 1 open"))
    await openList(tools.bar)
    const panel = tools.panel()!
    await vi.waitFor(() => expect(panel.querySelectorAll('[data-slot="comment-panel-item"]')).toHaveLength(1))
    expect(panel.textContent).toContain("Open one")
    panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-filter"][data-state="off"]')!.click()
    await vi.waitFor(() => expect(panel.textContent).toContain("Done one"))
    // Resolved pins show on the page while the list shows resolved threads.
    await vi.waitFor(() => expect(shadow.querySelectorAll('[data-slot="comment-pin"][data-status="resolved"]')).toHaveLength(1))
  })

  it("shows the Sign in with GitHub prompt to a person who may not read, once they open the tool", async () => {
    await serveComments({ identify: () => null, authorize: () => false })
    const tools = pageTools({ open: true })
    const { shadow } = await startOverlay(tools)
    await vi.waitFor(() => expect(shadow.querySelector(".toast")).not.toBeNull())
    expect(tools.bar.hidden).toBe(true)
    expect(shadow.querySelector(".toast")!.textContent).toContain("Comments are only for the site's team")
  })
})

describe("the Comments segment, as in Drop", () => {
  it("resumes a guest's Whole page action after they give their name", async () => {
    const { bar, shadow, comments } = await site(null, { authorize: () => true })
    commentsButton(bar)!.click()
    await vi.waitFor(() => expect(tool(bar, "Comment on the whole page")).not.toBeNull())
    tool(bar, "Comment on the whole page")!.click()
    const name = shadow.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!
    await type(name, "Ana García")
    name.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(composer(shadow, "Comment")).not.toBeNull())
    await type(composer(shadow, "Comment")!, "About the whole page")
    press(composer(shadow, "Comment")!, "Enter")
    await vi.waitFor(async () => expect((await comments.list())[1]).toHaveLength(1))
    const thread = (await comments.list())[1]![0]!
    expect(thread.anchor.kind).toBe("page")
    expect(thread.author).toEqual({ id: `guest:${readGuest()!.id}`, name: "Ana García", guest: true })
  })

  it("turns comment mode on and grows Whole page, All comments, and × beside it", async () => {
    const { bar, shadow } = await site(ada, {}, comments => comments.create({ page: "/pricing", anchor, body: "Open one", author: ada }))
    await vi.waitFor(() => expect(commentsButton(bar)?.getAttribute("aria-label")).toBe("Comments, 1 open"))
    expect(commentsButton(bar)!.textContent).toBe("Comments1")
    expect(tool(bar, "Comment on the whole page")).toBeNull()

    commentsButton(bar)!.click()
    await vi.waitFor(() => expect(commentsButton(bar)!.textContent).toBe("Click anywhere"))
    expect(commentsButton(bar)!.getAttribute("aria-pressed")).toBe("true")
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(true)
    expect(tool(bar, "All comments on this page")!.textContent).toBe("All comments1")

    tool(bar, "Comment on the whole page")!.click()
    await vi.waitFor(() => expect(shadow.querySelector('textarea[aria-label="Comment"]')).not.toBeNull())
    tool(bar, "Stop commenting (Esc)")!.click()
    await vi.waitFor(() => expect(tool(bar, "Comment on the whole page")).toBeNull())
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)
    expect(commentsButton(bar)!.textContent).toBe("Comments1")
  })

  it("turns comment mode on at once when a ?vitehub=comments link picked the tool", async () => {
    await serveComments({ identify: () => ada })
    const tools = pageTools({ linked: true })
    await startOverlay(tools)
    await vi.waitFor(() => expect(commentsButton(tools.bar)?.textContent).toBe("Click anywhere"))
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(true)
    expect(tools.context.createWindow).not.toHaveBeenCalled()
  })

  it("opens the list, as a tool restored from an earlier page does, without comment mode", async () => {
    await serveComments({ identify: () => ada })
    const tools = pageTools({ open: true })
    await startOverlay(tools)
    await vi.waitFor(() => expect(tools.context.createWindow).toHaveBeenCalled())
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)
  })

  it("opens the list for a reader that a ?vitehub=comments link brought", async () => {
    await serveComments({ identify: () => ada, authorize: ({ action }) => action === "read" })
    const tools = pageTools({ linked: true })
    await startOverlay(tools)
    await vi.waitFor(() => expect(tools.context.createWindow).toHaveBeenCalled())
    expect(document.documentElement.classList.contains("vitehub-comment-mode")).toBe(false)
  })

  it("opens the list from Comments for a person who may only read", async () => {
    const { bar } = await site(ada, { authorize: ({ action }) => action === "read" }, comments => comments.create({ page: "/pricing", anchor, body: "Open one", author: grace }))
    await vi.waitFor(() => expect(tool(bar, "Show comments")).not.toBeNull())
    expect(tool(bar, "Comment on the page (C)")).toBeNull()
    expect(tool(bar, "Highlight the page and comment (B)")).toBeNull()
    expect(commentsButton(bar)!.getAttribute("aria-expanded")).toBe("false")
  })
})
