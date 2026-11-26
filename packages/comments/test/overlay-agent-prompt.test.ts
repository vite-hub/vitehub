// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

import { commentsAgentPrompt, commentsT3CodeLink, t3CodeLinkLimit } from "../src/agent-prompt.ts"
import { defineCommentSubject } from "../src/operations-core/define.ts"
import { commentsButton, openList, pageTools, serveComments, startOverlay } from "./overlay-harness.ts"

import type { ViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"
import type { CommentsAgentPromptInput } from "../src/agent-prompt.ts"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ states: () => new Map(), people: () => [], onUpdate: vi.fn(), onChange: vi.fn(), onNotice: vi.fn(), notify: vi.fn(), setLocal: vi.fn(), destroy: vi.fn() })),
}))

const project = { id: "app-1", teamId: "team-1", url: "https://app.example.com/portal" }
const mcp = "https://console.vitehub.dev/mcp/account"
const member: ViteHubSiteVisitor = { id: "console-ada", name: "Ada", roles: ["console", "comments-write"], kind: "member", commentsAgent: { project, resolve: true } }
const guest: ViteHubSiteVisitor = { id: "guest-bob", name: "Bob", roles: ["comments-write"], kind: "guest" }
const anchor = { kind: "element", selector: "main > h1", x: 500, y: 500 } as const

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, "", "/pricing")
  document.body.innerHTML = "<main><h1>Pricing</h1></main>"
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 40))
})

afterEach(() => {
  for (const element of document.querySelectorAll("vitehub-comments, vitehub-pill")) element.remove()
  installViteHubSiteVisitor(async () => undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function site(visitor: ViteHubSiteVisitor, threads: number, build?: { repository: string }) {
  installViteHubSiteVisitor(async () => visitor)
  const subject = { kind: "drop", id: "42" }
  const server = await serveComments({
    subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
    page: ({ url }) => url.pathname === "/pricing" ? subject : undefined,
  }, build ? { build } : {})
  const ids: string[] = []
  let resolvedId: string | undefined
  for (let index = 0; index < threads; index++) {
    const author = { id: "grace", name: "Grace" }
    const [, thread] = await server.comments.create({ subject, anchor, body: `Fix ${index}`, author })
    if (index === 1) {
      await server.comments.resolve(thread!.id, { by: author })
      resolvedId = thread!.id
    }
    else ids.push(thread!.id)
  }
  const tools = pageTools()
  await startOverlay(tools)
  await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
  return { ...tools, ids, resolvedId, server }
}

function clipboard() {
  const writeText = vi.fn(async (_text: string) => undefined)
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
  return writeText
}

async function listed(tools: Awaited<ReturnType<typeof site>>) {
  await openList(tools.bar)
  await vi.waitFor(() => expect(tools.panel()?.querySelector('[data-slot="comment-panel-item"]')).toBeTruthy())
  return tools.panel()!
}

async function openedThread(tools: Awaited<ReturnType<typeof site>>) {
  const panel = await listed(tools)
  panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-item"]')!.click()
  await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-thread-actions"]')).toBeTruthy())
  return panel.querySelector<HTMLElement>('[data-slot="comment-thread-actions"]')!
}

const promptOf = (href: string) => new URL(href).searchParams.get("prompt")

describe("Open in T3 Code and Copy on a thread", () => {
  it("gives a Console member the thread's text and the ViteHub MCP steps, both ways", async () => {
    const writeText = clipboard()
    const tools = await site(member, 1, { repository: "acme/pricing" })
    const actions = await openedThread(tools)
    const open = actions.querySelector<HTMLAnchorElement>('a[data-action="open-in-t3-code"]')!
    expect(open.textContent).toContain("Open in T3 Code")
    expect(open.target).toBe("_blank")
    expect(open.rel).toBe("noopener noreferrer")
    const link = new URL(open.href)
    expect(link.origin + link.pathname).toBe("https://app.t3.codes/new")
    expect(link.searchParams.get("repo")).toBe("acme/pricing")
    actions.querySelector<HTMLButtonElement>('button[data-action="copy-prompt"]')!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const prompt = writeText.mock.calls[0]![0]
    expect(promptOf(open.href)).toBe(prompt)
    expect(prompt).toContain(`Fix this comment on ${location.origin}/pricing`)
    expect(prompt).toContain("\"Fix 0\" — Grace, on main > h1")
    for (const value of [tools.ids[0]!, project.url, project.teamId, "comments.get", "comments.resolve"]) expect(prompt).toContain(value)
  })

  it("gives a guest the thread without the ViteHub MCP steps, and no repo when the app has none", async () => {
    const writeText = clipboard()
    const tools = await site(guest, 1)
    const actions = await openedThread(tools)
    const open = actions.querySelector<HTMLAnchorElement>('a[data-action="open-in-t3-code"]')!
    expect(new URL(open.href).searchParams.has("repo")).toBe(false)
    actions.querySelector<HTMLButtonElement>('button[data-action="copy-prompt"]')!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const prompt = writeText.mock.calls[0]![0]
    expect(prompt).toContain("\"Fix 0\" — Grace")
    expect(prompt).toContain("When you are done, tell me what you changed.")
    expect(prompt).not.toMatch(/ViteHub MCP|comments\.get|comments\.resolve/)
  })
})

describe("Copy open in the panel header", () => {
  it("copies the open threads of the page, without the resolved one", async () => {
    const writeText = clipboard()
    const tools = await site(member, 3)
    const panel = await listed(tools)
    await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-panel-actions"] button[data-action="copy-open-prompt"]')).toBeTruthy())
    const open = panel.querySelector<HTMLAnchorElement>('[data-slot="comment-panel-actions"] a[data-action="open-in-t3-code"]')!
    panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-actions"] button[data-action="copy-open-prompt"]')!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const prompt = writeText.mock.calls[0]![0]
    expect(promptOf(open.href)).toBe(prompt)
    expect(prompt).toContain(`Fix these 2 comments on ${location.origin}/pricing`)
    for (const id of tools.ids) expect(prompt).toContain(id)
    expect(prompt).not.toContain(tools.resolvedId)
  })

  it("is not there while the page has no open threads", async () => {
    const tools = await site(member, 0)
    await openList(tools.bar)
    await vi.waitFor(() => expect(tools.panel()?.querySelector('[data-slot="comment-panel-empty"]')).toBeTruthy())
    expect(tools.panel()!.querySelector('[data-action="copy-open-prompt"]')).toBeNull()
  })
})

describe("the pill", () => {
  it("has no Copy prompt button", async () => {
    const { bar } = await site(member, 1)
    await vi.waitFor(() => expect(commentsButton(bar)?.getAttribute("aria-label")).toBe("Comments, 1 open"))
    expect(bar.shadowRoot!.querySelector('[data-action="copy-prompt"]')).toBeNull()
  })
})

describe("commentsAgentPrompt()", () => {
  const thread = {
    id: "thread-1",
    anchor,
    revision: 4,
    messages: [{ author: "Max", body: "The title wraps on a phone." }, { author: "Ada", body: "Also on a tablet." }],
    files: ["https://app.example.com/_vitehub/comments/files/f_1"],
  }
  const agent = { mcp, project, resolve: true }

  it("names the page, the text, the replies, the files, and the ViteHub MCP steps", () => {
    const prompt = commentsAgentPrompt({ url: "https://app.example.com/portal/pricing?tab=pro#plans", threads: [thread], agent })
    expect(prompt.split("\n")).toEqual([
      "Fix this comment on https://app.example.com/portal/pricing?tab=pro#plans",
      "\"The title wraps on a phone.\" — Max, on main > h1 (version 4)",
      "Reply: \"Also on a tablet.\" — Ada",
      "Files: https://app.example.com/_vitehub/comments/files/f_1",
      expect.stringContaining(`In the ViteHub MCP (${mcp})`),
      expect.stringContaining("comments.resolve"),
    ])
    for (const value of [project.url, project.id, project.teamId, "comments.get", "thread thread-1"]) expect(prompt).toContain(value)
  })

  it("asks for a report without resolve access, and has no MCP lines without a Console account", () => {
    const url = "https://app.example.com/pricing"
    expect(commentsAgentPrompt({ url, threads: [thread], agent: { ...agent, resolve: false } })).not.toMatch(/comments\.resolve|run_operation/)
    const guestPrompt = commentsAgentPrompt({ url, threads: [thread] })
    expect(guestPrompt).not.toMatch(/MCP|comments\.get|comments\.resolve/)
    expect(guestPrompt.endsWith("When you are done, tell me what you changed.")).toBe(true)
  })

  it("numbers several threads", () => {
    const prompt = commentsAgentPrompt({ url: "https://app.example.com/", threads: [thread, { ...thread, id: "thread-2", messages: [{ author: "Lin", body: "Bigger logo." }] }], agent })
    expect(prompt).toContain("Fix these 2 comments on https://app.example.com/")
    expect(prompt).toContain("1. \"The title wraps on a phone.\"")
    expect(prompt).toContain("2. \"Bigger logo.\"")
    expect(prompt).toContain("[\"thread-1\",\"thread-2\"]")
  })
})

describe("commentsT3CodeLink()", () => {
  const input = (body: string, count = 1): CommentsAgentPromptInput => ({
    url: "https://app.example.com/pricing",
    threads: Array.from({ length: count }, (_, index) => ({ id: `thread-${index}`, anchor, messages: [{ author: "Max", body }] })),
    agent: { mcp, project, resolve: true },
  })

  it("opens a new T3 Code thread with the prompt, in the repository when it is a GitHub owner/name", () => {
    const link = new URL(commentsT3CodeLink(input("Fix it"), "acme/site.web"))
    expect(link.origin + link.pathname).toBe("https://app.t3.codes/new")
    expect(link.searchParams.get("prompt")).toBe(commentsAgentPrompt(input("Fix it")))
    expect(link.searchParams.get("repo")).toBe("acme/site.web")
    for (const repository of [undefined, "", "acme", "acme/..", "-acme/site", "acme/site/extra"]) expect(new URL(commentsT3CodeLink(input("Fix it"), repository)).searchParams.has("repo")).toBe(false)
  })

  it(`keeps a long prompt under ${t3CodeLinkLimit} characters, with its steps and shorter messages`, () => {
    const body = "The title wraps on a phone. ".repeat(600)
    const href = commentsT3CodeLink(input(body), "acme/site")
    expect(href.length).toBeLessThanOrEqual(t3CodeLinkLimit)
    const prompt = promptOf(href)!
    expect(prompt).toContain("Fix this comment on https://app.example.com/pricing")
    expect(prompt).toContain("…")
    expect(prompt).toContain("comments.resolve")
  })

  it.each([
    { name: "short IDs", id: (index: number) => `thread-${index}` },
    { name: "IDs too long for the link", id: (index: number) => `thread-${index}-${"x".repeat(120)}` },
  ])(`keeps every step and every thread of 100 open threads with $name in ${t3CodeLinkLimit} characters`, ({ id }) => {
    const threads = input("A long comment. ".repeat(50), 100).threads.map((thread, index) => ({ ...thread, id: id(index) }))
    const href = commentsT3CodeLink({ ...input("", 0), threads }, "acme/site")
    expect(href.length).toBeLessThanOrEqual(t3CodeLinkLimit)
    const prompt = promptOf(href)!
    expect(prompt).toContain("call read_operation with the app id")
    expect(prompt).toContain("operation \"comments.resolve\"")
    const everyId = threads.every(thread => prompt.includes(thread.id))
    const listed = prompt.startsWith("Fix the 100 open comments on https://app.example.com/pricing") && prompt.includes("operation \"comments.list\", and input { page: \"https://app.example.com/pricing\", status: \"open\"")
    expect(everyId || listed).toBe(true)
    expect(prompt).not.toContain("A long comment. A long comment.")
  })

  it("lists the open threads through the ViteHub MCP when the thread IDs do not fit", () => {
    const threads = input("Fix it", 100).threads.map((thread, index) => ({ ...thread, id: `thread-${index}-${"x".repeat(120)}` }))
    const prompt = promptOf(commentsT3CodeLink({ ...input("", 0), threads }))!
    expect(prompt).toMatch(/^Fix the 100 open comments on https:\/\/app\.example\.com\/pricing\n/)
    expect(prompt).toContain("operation \"comments.list\"")
    expect(prompt).not.toContain(threads[0]!.id)
  })

  it("gives a guest a short title per thread, or the count, and still asks for a report", () => {
    const { threads, url } = input("A long comment. ".repeat(50), 100)
    const href = commentsT3CodeLink({ url, threads })
    expect(href.length).toBeLessThanOrEqual(t3CodeLinkLimit)
    const prompt = promptOf(href)!
    expect(prompt).not.toMatch(/MCP|comments\.(get|list|resolve)/)
    expect(prompt.endsWith("When you are done, tell me what you changed.")).toBe(true)
  })
})
