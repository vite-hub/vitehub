// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

import { commentsAgentPrompt, commentsPagePrompt, commentsT3CodeLink, t3CodeLinkLimit } from "../src/agent-prompt.ts"
import { defineCommentSubject } from "../src/operations-core/define.ts"
import { commentsOperations } from "../src/operations-core/operations.ts"
import { commentsButton, openList, pageTools, serveComments, startOverlay, tool } from "./overlay-harness.ts"

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

async function site(visitor: ViteHubSiteVisitor, openThreads: number, { resolvedThreads = 0, build }: { resolvedThreads?: number, build?: { repository: string } } = {}) {
  installViteHubSiteVisitor(async () => visitor)
  const subject = { kind: "drop", id: "42" }
  const server = await serveComments({
    subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
    page: ({ url }) => url.pathname === "/pricing" ? subject : undefined,
  }, build ? { build } : {})
  const ids: string[] = []
  for (let index = 0; index < openThreads + resolvedThreads; index++) {
    const author = { id: "grace", name: "Grace" }
    const [, thread] = await server.comments.create({ subject, anchor, body: `Fix ${index}`, author })
    if (index >= openThreads) {
      const [resolveError, resolved] = await server.comments.resolve(thread!.id, { by: author })
      expect(resolveError).toBeUndefined()
      const now = vi.spyOn(Date, "now").mockReturnValue(resolved!.resolvedAt! + 1)
      try {
        const [error] = await server.comments.reply(thread!.id, { body: "Still needs work", author }, { allowResolved: true })
        expect(error).toBeUndefined()
      }
      finally {
        now.mockRestore()
      }
    }
    ids.push(thread!.id)
  }
  const tools = pageTools()
  await startOverlay(tools)
  await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
  return { ...tools, ids, server }
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
    const tools = await site(member, 1, { build: { repository: "acme/pricing" } })
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
  it("copies the open threads of the page, without the resolved thread with a later reply", async () => {
    const writeText = clipboard()
    const tools = await site(member, 2, { resolvedThreads: 1 })
    const panel = await listed(tools)
    await vi.waitFor(() => expect(panel.querySelector('[data-slot="comment-panel-actions"] button[data-action="copy-open-prompt"]')).toBeTruthy())
    const open = panel.querySelector<HTMLAnchorElement>('[data-slot="comment-panel-actions"] a[data-action="open-in-t3-code"]')!
    panel.querySelector<HTMLButtonElement>('[data-slot="comment-panel-actions"] button[data-action="copy-open-prompt"]')!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const prompt = writeText.mock.calls[0]![0]
    expect(promptOf(open.href)).toBe(prompt)
    expect(prompt).toContain(`Fix these 2 comments on ${location.origin}/pricing`)
    const [firstOpen, secondOpen, resolved] = tools.ids
    for (const value of [firstOpen, secondOpen, project.url, project.teamId, "comments.get", "comments.resolve"]) expect(prompt).toContain(value)
    expect(prompt).not.toContain(resolved)
    expect(prompt).not.toContain("Still needs work")
  })

  it("is not there while the page has no open threads", async () => {
    const tools = await site(member, 0)
    await openList(tools.bar)
    await vi.waitFor(() => expect(tools.panel()?.querySelector('[data-slot="comment-panel-empty"]')).toBeTruthy())
    expect(tools.panel()!.querySelector('[data-action="copy-open-prompt"]')).toBeNull()
  })

  it("hides panel and pill prompts while the next page is loading", async () => {
    const writeText = clipboard()
    const tools = await site(member, 1)
    await listed(tools)
    const actions = () => tools.panel()?.querySelector('[data-slot="comment-panel-actions"]')
    await vi.waitFor(() => expect(actions()?.querySelector('[data-action="copy-open-prompt"]')).toBeTruthy())
    expect(actions()?.querySelector('[data-action="open-in-t3-code"]')).toBeTruthy()
    const pillPrompt = () => tools.bar.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="copy-page-prompt"]')
    tool(tools.bar, "Stop commenting (C)")!.click()
    await vi.waitFor(() => expect(pillPrompt()).not.toBeNull())
    const previous = pillPrompt()!
    const fetchComments = tools.server.fetch.getMockImplementation()!
    let endSession = () => {}
    const session = new Promise<void>((resolve) => { endSession = resolve })
    let loading = false
    tools.server.fetch.mockImplementation(async (input, init) => {
      if (String(input).includes("/session")) {
        loading = true
        await session
      }
      return fetchComments(input, init)
    })
    try {
      history.pushState(null, "", "/details")
      await vi.waitFor(() => expect(loading).toBe(true))
      await vi.waitFor(() => expect(actions()).toBeFalsy())
      expect(pillPrompt()).toBeNull()
      previous.click()
      expect(writeText).not.toHaveBeenCalled()
    }
    finally {
      endSession()
    }
    await vi.waitFor(() => expect(tools.panel()?.querySelector('[data-slot="comment-panel-empty"]')).toBeTruthy())
    expect(actions()?.querySelector('[data-action="copy-open-prompt"], [data-action="open-in-t3-code"]')).toBeFalsy()
    expect(pillPrompt()).toBeNull()
  })

  it("offers the full copy instead of an oversized T3 Code link", async () => {
    const writeText = clipboard()
    const url = `${project.url}/${"x".repeat(t3CodeLinkLimit)}`
    const tools = await site({ ...member, commentsAgent: { project: { ...project, url }, resolve: true } }, 3)
    const panel = await listed(tools)
    const actions = panel.querySelector('[data-slot="comment-panel-actions"]')!
    expect(actions.querySelector('[data-action="open-in-t3-code"]')).toBeNull()
    expect(actions.textContent).toContain("Copy the prompt instead.")
    actions.querySelector<HTMLButtonElement>('[data-action="copy-open-prompt"]')!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const prompt = writeText.mock.calls[0]![0]
    for (const value of [url, ...tools.ids, "comments.resolve"]) expect(prompt).toContain(value)
  })
})

describe("Copy prompt in the pill", () => {
  const pagePrompt = (bar: HTMLElement) => bar.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="copy-page-prompt"]')

  it("copies the exact open thread IDs, including mapped subjects and their replies", async () => {
    const writeText = clipboard()
    const { bar, ids, server } = await site({ ...member, commentsAgent: { project: { ...project, name: "Acme Docs" }, resolve: true } }, 2, { resolvedThreads: 1 })
    const [error] = await server.comments.reply(ids[0]!, { body: "Also on a tablet", author: { id: "grace", name: "Grace" } })
    expect(error).toBeUndefined()
    await vi.waitFor(() => expect(pagePrompt(bar)?.querySelector('[data-shown="true"]')?.textContent).toBe("Copy prompt"))
    pagePrompt(bar)!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const lines = writeText.mock.calls[0]![0].split("\n")
    expect(lines).toEqual([
      "I left 2 comments on http://localhost:3000/pricing",
      expect.stringContaining(`open app "Acme Docs" (app.example.com) through the ViteHub MCP (${mcp})`),
      "Fix each comment, then resolve it with run_operation, the app id, operation \"comments.resolve\", and input { threadId, reply }. Say what you changed in the reply.",
    ])
    const [, operation, json] = /operation "([^"]+)", and input \{ threadId \} for each ID in (\[.*\])\.$/.exec(lines[1]!)!
    const selected: string[] = JSON.parse(json!)
    expect(selected.toSorted()).toEqual(ids.slice(0, 2).toSorted())
    const registry = createOperationRegistry([{ operations: commentsOperations }])
    const threads = await Promise.all(selected.map(threadId => runOperation(registry, operation!, { threadId }, {
      access: { mode: "auth", sections: "all" },
      surface: "console",
      user: { id: member.id, name: member.name, email: "ada@example.com" },
    })))
    expect(threads).toEqual(expect.arrayContaining([
      { ok: true, value: expect.objectContaining({ id: ids[0], messages: [expect.objectContaining({ body: "Fix 0" }), expect.objectContaining({ body: "Also on a tablet" })] }) },
      { ok: true, value: expect.objectContaining({ id: ids[1], messages: [expect.objectContaining({ body: "Fix 1" })] }) },
    ]))
    await vi.waitFor(() => expect(pagePrompt(bar)?.querySelector('[data-shown="true"]')?.textContent).toBe("Copied"))
  })

  it("copies the open threads' text for a guest, whose agent cannot read them in the Console", async () => {
    const writeText = clipboard()
    const { bar } = await site(guest, 1)
    await vi.waitFor(() => expect(pagePrompt(bar)).not.toBeNull())
    pagePrompt(bar)!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0]![0]).toContain("\"Fix 0\" — Grace")
    expect(writeText.mock.calls[0]![0]).not.toContain("ViteHub MCP")
  })

  it("is not there while the page has no open threads", async () => {
    const { bar } = await site(member, 0, { resolvedThreads: 1 })
    await vi.waitFor(() => expect(commentsButton(bar)?.getAttribute("aria-label")).toBe("Comments"))
    expect(pagePrompt(bar)).toBeNull()
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

describe("commentsPagePrompt()", () => {
  const threads = [{ id: "thread-1", anchor, messages: [{ author: "Max", body: "The title wraps." }] }]

  it("names the app by its host when the Console has no name for it, and asks for a report without resolve access", () => {
    const prompt = commentsPagePrompt({ url: "https://app.example.com/portal/pricing?tab=pro", threads, agent: { mcp, project, resolve: false } })
    expect(prompt.split("\n")).toEqual([
      "I left a comment on https://app.example.com/portal/pricing?tab=pro",
      `In the ViteHub Console, open app app.example.com through the ViteHub MCP (${mcp}): find it with list_apps (id: app-1, team team-1; if it is missing, ask me to switch team), then call read_operation with the app id, operation "comments.get", and input { threadId } for each ID in ["thread-1"].`,
      "Fix each comment and tell me what you changed.",
    ])
  })

  it("is commentsAgentPrompt() without a Console account", () => {
    const input = { url: "https://app.example.com/pricing", threads }
    expect(commentsPagePrompt(input)).toBe(commentsAgentPrompt(input))
  })
})

describe("commentsT3CodeLink()", () => {
  const input = (body: string, count = 1): CommentsAgentPromptInput => ({
    url: "https://app.example.com/pricing",
    threads: Array.from({ length: count }, (_, index) => ({ id: `thread-${index}`, anchor, messages: [{ author: "Max", body }] })),
    agent: { mcp, project, resolve: true },
  })

  it("opens a new T3 Code thread with the prompt, in the repository when it is a GitHub owner/name", () => {
    const link = new URL(commentsT3CodeLink(input("Fix it"), "acme/site.web")!)
    expect(link.origin + link.pathname).toBe("https://app.t3.codes/new")
    expect(link.searchParams.get("prompt")).toBe(commentsAgentPrompt(input("Fix it")))
    expect(link.searchParams.get("repo")).toBe("acme/site.web")
    for (const repository of [undefined, "", "acme", "acme/..", "-acme/site", "acme/site/extra"]) expect(new URL(commentsT3CodeLink(input("Fix it"), repository)!).searchParams.has("repo")).toBe(false)
  })

  it(`keeps a long prompt under ${t3CodeLinkLimit} characters, with its steps and shorter messages`, () => {
    const body = "The title wraps on a phone. ".repeat(600)
    const href = commentsT3CodeLink(input(body), "acme/site")!
    expect(href.length).toBeLessThanOrEqual(t3CodeLinkLimit)
    const prompt = promptOf(href)!
    expect(prompt).toContain("Fix this comment on https://app.example.com/pricing")
    expect(prompt).toContain("…")
    expect(prompt).toContain("comments.resolve")
  })

  it("keeps the anchor excerpt and MCP steps for a long text selection", () => {
    const data = input("Fix it")
    const [thread] = data.threads
    const exact = "字".repeat(900)
    const href = commentsT3CodeLink({ ...data, threads: [{ ...thread!, anchor: { kind: "text", selector: "main", exact, prefix: "", suffix: "" } }] })!
    expect(href.length).toBeLessThanOrEqual(t3CodeLinkLimit)
    const prompt = promptOf(href)!
    expect(prompt).toContain('on the text "字')
    expect(prompt).not.toContain(exact)
    expect(prompt).toContain("comments.get")
    expect(prompt).toContain("comments.resolve")
  })

  it(`keeps every ID and MCP step of a batch of 60 with replies in ${t3CodeLinkLimit} characters`, () => {
    const data = input("Fix it", 60)
    const threads = data.threads.map(thread => ({ ...thread, messages: [...thread.messages, { author: "Lin", body: "On mobile too." }] }))
    const href = commentsT3CodeLink({ ...data, threads }, "acme/site")!
    expect(href.length).toBeLessThanOrEqual(t3CodeLinkLimit)
    const prompt = promptOf(href)!
    expect(prompt).toContain("call read_operation with the app id")
    expect(prompt).toContain("operation \"comments.resolve\"")
    expect(prompt).toContain(JSON.stringify(threads.map(thread => thread.id)))
  })

  it("makes no link when the thread IDs or the page URL do not fit", () => {
    const threads = input("Fix it", 100).threads.map((thread, index) => ({ ...thread, id: `thread-${index}-${"x".repeat(120)}` }))
    expect(commentsT3CodeLink({ ...input("", 0), threads })).toBeUndefined()
    expect(commentsT3CodeLink({ ...input("Fix it"), url: `https://app.example.com/${"x".repeat(t3CodeLinkLimit)}` })).toBeUndefined()
  })

  it("gives a guest a short title per thread and still asks for a report", () => {
    const { threads, url } = input("A long comment. ".repeat(50), 100)
    const href = commentsT3CodeLink({ url, threads })!
    expect(href.length).toBeLessThanOrEqual(t3CodeLinkLimit)
    const prompt = promptOf(href)!
    expect(prompt).not.toMatch(/MCP|comments\.(get|list|resolve)/)
    expect(prompt.endsWith("When you are done, tell me what you changed.")).toBe(true)
    for (const thread of threads) expect(prompt).toContain(`${thread.id}:`)
  })
})
