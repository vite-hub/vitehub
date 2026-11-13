import { H3 } from "h3"
import { files, github } from "@vite-hub/source"
import { afterEach, describe, expect, it, vi } from "vitest"

import { contentSource, defineContent, defineContentHandler, defineContentLlmsHandler, defineContentMarkdownHandler, defineContentMcpHandler, defineContentRobotsHandler, defineContentRssHandler, defineContentSitemapHandler } from "../src/index.ts"

import type { ContentAuthorize, DefineContentSeoOptions } from "../src/index.ts"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const secret = "Salary bands: confidential."

function handbook(authorize: ContentAuthorize | undefined, seo: DefineContentSeoOptions = { llms: true, mcp: true }, access: { route?: boolean, access?: "public" } = {}) {
  const content = defineContent({
    logger: false,
    ...access,
    ...(authorize ? { authorize } : {}),
    sources: { handbook: contentSource(files({ "salary.md": `---\ntitle: Salary\n---\n${secret}\n` }), { url: "/handbook/:id" }) },
    seo: { site: "https://example.com", ...seo },
  })
  cleanup.push(() => content.dispose())
  return content
}

function mcpRequest(name: string, args: Record<string, unknown>): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })
}

async function readers(content: ReturnType<typeof handbook>, user?: () => Record<string, unknown> | null) {
  const options = user ? { user } : {}
  return {
    api: await defineContentHandler(content, options).fetch(new Request("https://example.com/api/content/get/handbook/salary")),
    llms: await defineContentLlmsHandler(content, options).fetch(new Request("https://example.com/llms-full.txt")),
    markdown: await new H3().use(defineContentMarkdownHandler(content, options)).all("/**", () => "page").request("https://example.com/handbook/salary.md"),
    negotiated: await new H3().use(defineContentMarkdownHandler(() => content, options)).all("/**", () => "page").request("https://example.com/handbook/salary", { headers: { accept: "text/markdown" } }),
    mcp: await defineContentMcpHandler(content, options).fetch(mcpRequest("get-page", { path: "/handbook/salary" })),
    sitemap: await defineContentSitemapHandler(content, options).fetch(new Request("https://example.com/sitemap.xml")),
    rss: await defineContentRssHandler(content, options).fetch(new Request("https://example.com/rss.xml")),
  }
}

describe("generated Content readers", { timeout: 30_000 }, () => {
  const allReaders = { llms: true, mcp: true, sitemap: true, rss: true } as const

  it("asks authorize for read on every reader, and leaks no body when it denies", async () => {
    const policy = vi.fn<ContentAuthorize>(() => false)
    const responses = await readers(handbook(policy, allReaders))
    for (const [name, response] of Object.entries(responses)) {
      expect.soft(response.status, name).toBe(401)
      expect.soft(response.headers.get("cache-control"), name).toBe("private, no-store")
      expect.soft(await response.text(), name).not.toContain(secret)
    }
    expect(policy).toHaveBeenCalledWith({ user: null, action: "read" })
    expect(policy.mock.calls.every(([context]) => context.action === "read")).toBe(true)
  })

  it("answers 403 to a signed-in user that authorize denies", async () => {
    const responses = await readers(handbook(({ user }) => user?.id === "ana", allReaders), () => ({ id: "ben" }))
    for (const [name, response] of Object.entries(responses)) expect.soft(response.status, name).toBe(403)
  })

  it("serves an allowed user with private, no-store", async () => {
    const responses = await readers(handbook(({ user }) => user?.id === "ana", allReaders), () => ({ id: "ana" }))
    for (const [name, response] of Object.entries(responses)) {
      expect.soft(response.status, name).toBe(200)
      expect.soft(response.headers.get("cache-control"), name).toBe("private, no-store")
    }
    expect(await responses.llms.text()).toContain(secret)
    expect(await responses.markdown.text()).toContain(secret)
    expect(await responses.mcp.text()).toContain("Salary bands")
  })

  it("serves everyone without authorize when access is public", async () => {
    const policy = vi.fn<ContentAuthorize>(() => false)
    const responses = await readers(handbook(policy, allReaders, { access: "public" }))
    for (const [name, response] of Object.entries(responses)) expect.soft(response.status, name).toBe(200)
    expect(responses.llms.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate")
    expect(policy).not.toHaveBeenCalled()
  })

  it("asks authorize when route is false", async () => {
    const responses = await readers(handbook(() => false, allReaders, { route: false }))
    expect(responses.api.status).toBe(404)
    for (const name of ["llms", "markdown", "mcp", "sitemap", "rss"] as const) expect.soft(responses[name].status, name).toBe(401)
  })

  it("keeps robots.txt public, because it names no page", async () => {
    const response = await defineContentRobotsHandler(handbook(() => false, { robots: true })).fetch(new Request("https://example.com/robots.txt"))
    expect(response.status).toBe(200)
  })

  it("requires a decision before any reader serves a github() Source", () => {
    const docs = github({ repo: "acme/private" })
    for (const seo of [{ llms: true }, { mcp: true }, { sitemap: true }, { rss: true }, { markdown: true }] satisfies DefineContentSeoOptions[]) {
      expect(() => defineContent({ sources: { docs }, route: false, seo }), JSON.stringify(seo)).toThrow(/authorize/)
    }
    expect(() => defineContent({ sources: { docs }, route: false, previews: true })).toThrow(/authorize/)
    expect(() => defineContent({ sources: { docs }, route: false, seo: { robots: true } })).not.toThrow()
    expect(() => defineContent({ sources: { docs }, route: false, seo: { llms: true }, authorize: ({ action }) => action === "read" })).not.toThrow()
    expect(() => defineContent({ sources: { docs }, access: "public", seo: { llms: true }, previews: true })).not.toThrow()
  })
})
