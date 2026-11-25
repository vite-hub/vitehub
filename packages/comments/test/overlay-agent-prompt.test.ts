// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

import { commentsAgentPrompt } from "../src/agent-prompt.ts"
import { defineCommentSubject } from "../src/operations-core/define.ts"
import { commentsButton, pageTools, serveComments, startOverlay } from "./overlay-harness.ts"

import type { ViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ states: () => new Map(), people: () => [], onUpdate: vi.fn(), onChange: vi.fn(), notify: vi.fn(), setLocal: vi.fn(), destroy: vi.fn() })),
}))

const project = { id: "app-1", teamId: "team-1", url: "https://app.example.com/portal" }
const member: ViteHubSiteVisitor = { id: "console-ada", name: "Ada", roles: ["console", "comments-write"], kind: "member", commentsAgent: { project, resolve: true } }
const guest: ViteHubSiteVisitor = { id: "guest-bob", name: "Bob", roles: ["comments-write"], kind: "guest" }
const anchor = { kind: "element", selector: "main > h1", x: 500, y: 500 } as const
const copyButton = (bar: HTMLElement) => bar.shadowRoot?.querySelector<HTMLButtonElement>('button[data-action="copy-prompt"]') ?? null

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

async function site(visitor: ViteHubSiteVisitor, threads: number) {
  installViteHubSiteVisitor(async () => visitor)
  const subject = { kind: "drop", id: "42" }
  const server = await serveComments({
    subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
    page: ({ url }) => url.pathname === "/pricing" ? subject : undefined,
  })
  const ids: string[] = []
  for (let index = 0; index < threads; index++) {
    const author = { id: "grace", name: "Grace" }
    const [, thread] = await server.comments.create({ subject, anchor, body: `Fix ${index}`, author })
    if (index === 1) {
      const [, resolved] = await server.comments.resolve(thread!.id, { by: author })
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

describe("Copy prompt in the comment pill", () => {
  it("copies three lines that send a Console member's agent to the open threads through the ViteHub MCP", async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const { bar, ids } = await site(member, 2)
    await vi.waitFor(() => expect(copyButton(bar)).not.toBeNull())
    expect(copyButton(bar)!.getAttribute("aria-label")).toBe("Copy a prompt for your agent: 2 open comments")
    copyButton(bar)!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0]![0]).toContain(`Fix the 2 open ViteHub comments on ${location.origin}/pricing`)
    for (const value of [...ids, project.url, project.teamId, "comments.get", "comments.resolve"]) expect(writeText.mock.calls[0]![0]).toContain(value)
  })

  it("does not offer a prompt when the member only has page access", async () => {
    const { bar } = await site({ ...member, commentsAgent: undefined }, 1)
    await vi.waitFor(() => expect(commentsButton(bar)?.getAttribute("aria-label")).toBe("Comments, 1 open"))
    expect(copyButton(bar)).toBeNull()
  })

  it("hides the prompt while the next page is loading", async () => {
    const { bar, server } = await site(member, 1)
    await vi.waitFor(() => expect(copyButton(bar)).not.toBeNull())
    const fetch = server.fetch.getMockImplementation()!
    let releaseSession!: () => void
    const pendingSession = new Promise<void>((resolve) => { releaseSession = resolve })
    server.fetch.mockImplementation(async (input, init) => {
      if (String(input).includes("/session")) await pendingSession
      return fetch(input, init)
    })
    try {
      history.pushState(null, "", "/next")
      await vi.waitFor(() => expect(copyButton(bar)).toBeNull())
      expect(commentsButton(bar)?.getAttribute("aria-label")).toBe("Comments, 1 open")
    }
    finally {
      releaseSession()
    }
    await vi.waitFor(() => expect(commentsButton(bar)?.getAttribute("aria-label")).toBe("Comments"))
  })

  it("is not there for a guest of Site access, whom the ViteHub MCP does not know", async () => {
    const { bar } = await site(guest, 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(copyButton(bar)).toBeNull()
  })

  it("is not there while the page has no open threads", async () => {
    const { bar } = await site(member, 0)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(copyButton(bar)).toBeNull()
  })
})

describe("commentsAgentPrompt()", () => {
  it("names the page, the MCP, the app, and the resolve step in three lines", () => {
    const input = { url: "https://app.example.com/portal/pricing?tab=pro#plans", threadIds: ["thread-1"], project, mcp: "https://console.vitehub.dev/mcp/account" }
    const prompt = commentsAgentPrompt({ ...input, resolve: true })
    expect(prompt.split("\n")).toHaveLength(3)
    expect(prompt).toContain(input.url)
    for (const value of [project.url, project.id, project.teamId, "comments.get", "thread-1", "comments.resolve"]) expect(prompt).toContain(value)
    expect(commentsAgentPrompt({ ...input, resolve: false })).not.toMatch(/comments\.resolve|run_operation/)
  })
})
