// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

import { commentsAgentPrompt } from "../src/agent-prompt.ts"
import { commentsButton, pageTools, serveComments, startOverlay } from "./overlay-harness.ts"

import type { ViteHubSiteVisitor } from "@vite-hub/internal/runtime/page-tools"

vi.mock("@vite-hub/realtime/client", () => ({
  connectRealtimeRoom: vi.fn(() => ({ states: () => new Map(), people: () => [], onUpdate: vi.fn(), onChange: vi.fn(), notify: vi.fn(), setLocal: vi.fn(), destroy: vi.fn() })),
}))

const member: ViteHubSiteVisitor = { id: "console-ada", name: "Ada", roles: ["console", "comments-write"], kind: "member" }
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
  const server = await serveComments({})
  for (let n = 0; n < threads; n++) await server.comments.create({ page: "/pricing", anchor, body: `Fix ${n}`, author: { id: "grace", name: "Grace" } })
  const tools = pageTools()
  await startOverlay(tools)
  await vi.waitFor(() => expect(commentsButton(tools.bar)).not.toBeNull())
  return tools
}

describe("Copy prompt in the comment pill", () => {
  it("copies three lines that send a Console member's agent to the open threads through the ViteHub MCP", async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const { bar } = await site(member, 2)
    await vi.waitFor(() => expect(copyButton(bar)).not.toBeNull())
    expect(copyButton(bar)!.getAttribute("aria-label")).toBe("Copy a prompt for your agent: 2 open comments")
    copyButton(bar)!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0]![0]).toBe(commentsAgentPrompt({ url: `${location.origin}/pricing`, count: 2, mcp: "https://console.vitehub.dev/mcp/account" }))
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
    expect(commentsAgentPrompt({ url: "https://app.example.com/pricing?tab=pro#plans", count: 1, mcp: "https://console.vitehub.dev/mcp/account" })).toBe([
      "Fix the open ViteHub comment on https://app.example.com/pricing?tab=pro#plans",
      "Read them with the ViteHub MCP (https://console.vitehub.dev/mcp/account): list_apps finds the app https://app.example.com, then read_operation comments.threads with page \"/pricing\".",
      "After each fix, resolve the thread with run_operation comments.resolve and a reply that says what changed.",
    ].join("\n"))
  })
})
