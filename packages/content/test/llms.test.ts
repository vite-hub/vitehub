import { readFile } from "node:fs/promises"
import { H3, HTTPError, HTTPResponse } from "h3"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { documents, singleton } from "../src/collections.ts"
import { files } from "@vite-hub/source"

import { acceptsMarkdown, contentSource, defineContent, defineContentLlmsHandler, defineContentMarkdownHandler, renderContentLlms, renderContentMarkdownNotFound, renderContentSitemapMarkdown, seo } from "../src/index.ts"
import { historyWorkspace } from "./history-workspace.ts"

import type { DefineContentSeoOptions } from "../src/index.ts"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const fixture = async (name: string) => await readFile(new URL(`./fixtures/docs-agent-files/${name}`, import.meta.url), "utf8")

async function site(seoOptions: DefineContentSeoOptions = { site: "https://example.com", llms: { title: "Example", description: "Notes about examples." } }) {
  const content = defineContent({
    workspace: await historyWorkspace(cleanup),
    collections: {
      settings: singleton({ path: "settings.json", fields: { title: z.string() }, url: "/settings" }),
      home: singleton({ path: "home.md", fields: { title: z.string() }, url: "/" }),
      posts: documents({ path: "posts/*.md", label: "Blog", fields: { title: z.string(), description: z.string().optional(), seo: seo() }, url: "/blog/:id" }),
      articles: documents({ path: "articles/*.md", fields: { title: z.string(), slug: z.string() }, url: "/articles/:slug" }),
      guides: documents({ path: "guides/{locale}/*.md", locales: ["en", "es"], fields: { title: z.string() }, url: "/guides/:id" }),
      notes: documents({ path: "notes/*.md", fields: { title: z.string() } }),
    },
    seo: seoOptions,
    logger: false,
  })
  cleanup.push(() => content.dispose())
  const posts = content.collection("posts")
  await content.collection("settings").save({ data: { title: "Settings" } })
  await content.collection("home").save({ data: { title: "Home" }, body: "Welcome to [the blog](/blog/hello)." })
  await posts.save("hello", { data: { title: "Hello", description: "The first post." }, body: "Hello body." })
  await posts.save("about", { data: { title: "About", seo: { title: "About us", description: "Who we are." } }, body: "About body." })
  await posts.save("hidden", { data: { title: "Hidden", seo: { noindex: true } }, body: "Hidden body." })
  await posts.save("copy", { data: { title: "Copy", seo: { canonical: "/blog/hello" } }, body: "Copy body." })
  await posts.save("draft", { data: { title: "Draft only" }, body: "Draft body." })
  await content.collection("guides").save("start", { data: { title: "Start" }, body: "Start body." })
  await content.collection("guides").save("start", { data: { title: "Empezar" }, body: "Cuerpo." }, { locale: "es" })
  await content.collection("notes").save("private", { data: { title: "Private" }, body: "Private body." })
  await content.publish({ ids: ["hello", "about", "hidden", "copy"], collection: "posts" })
  await content.publish({ collection: "home" })
  await content.publish({ collection: "settings" })
  await content.publish({ collection: "guides" })
  await content.publish({ collection: "notes" })
  return content
}

describe("llms files", { timeout: 30_000 }, () => {
  it("lists published, indexable Markdown pages in llms.txt", async () => {
    const content = await site()
    expect(await content.llms()).toBe([
      "# Example",
      "> Notes about examples.",
      "## Overview",
      "- [Example](https://example.com/index.md)",
      "## Documentation Sets",
      "- [Example](https://example.com/llms-full.txt): Notes about examples.",
      "## Blog",
      "Every page below is available as raw markdown.",
      "- [About us](https://example.com/blog/about.md): Who we are.\n- [Hello](https://example.com/blog/hello.md): The first post.",
      "## Guides",
      "Every page below is available as raw markdown.",
      "- [Empezar](https://example.com/es/guides/start.md)\n- [Start](https://example.com/guides/start.md)",
    ].join("\n\n"))
    // Drafts, noindex pages, pages canonical to another URL, data files, and collections without a URL stay out.
    const text = await content.llms()
    for (const left of ["Draft only", "Hidden", "Copy", "Settings", "Private"]) expect(text).not.toContain(left)
  })

  it("joins every page copy in llms-full.txt, each with its URL", async () => {
    const content = await site()
    const full = await content.llms({ file: "llms-full.txt" })
    expect(full).toBe(`${[
      "# Example\n\n> Notes about examples.",
      "URL: https://example.com/\n\n# Home\n\nWelcome to [the blog](https://example.com/blog/hello).",
      "URL: https://example.com/blog/about\n\n# About us\n\n> Who we are.\n\nAbout body.",
      "URL: https://example.com/blog/hello\n\n# Hello\n\n> The first post.\n\nHello body.",
      "URL: https://example.com/es/guides/start\n\n# Empezar\n\nCuerpo.",
      "URL: https://example.com/guides/start\n\n# Start\n\nStart body.",
    ].join("\n\n---\n\n")}\n`)
    expect(full).not.toContain("Draft body")
    expect(full).not.toContain("Private body")
  })

  it("escapes link titles and quotes every line of the description", async () => {
    expect(renderContentLlms({
      title: "Example",
      description: "Line one.\nLine two.",
      details: "Rules for agents.\nRead them.",
      sections: [{ title: "Docs", links: [
        { title: "Array[0] and \\ guide", href: "https://example.com/a.md", description: "Two\n  lines." },
        { title: "[Draft]", href: "https://example.com/b.md" },
      ] }],
    })).toBe([
      "# Example",
      "> Line one.\n> Line two.",
      "Rules for agents.\nRead them.",
      "## Docs",
      "- [Array\\[0\\] and \\\\ guide](https://example.com/a.md): Two lines.\n- [\\[Draft\\]](https://example.com/b.md)",
    ].join("\n\n"))
    const content = await site({ site: "https://example.com", llms: { title: "Ex]ample", description: "First line.\nSecond line." } })
    await content.collection("posts").save("brackets", { data: { title: "Arrays [and] lists" }, body: "Body." })
    await content.publish({ ids: ["brackets"], collection: "posts" })
    const text = await content.llms()
    expect(text).toContain("> First line.\n> Second line.")
    expect(text).toContain("- [Ex\\]ample](https://example.com/llms-full.txt): First line. Second line.")
    expect(text).toContain("- [Arrays \\[and\\] lists](https://example.com/blog/brackets.md)")
  })

  it("groups pages by their first path segment in sitemap.md", async () => {
    const content = await site({ site: "https://example.com", llms: true })
    expect(await content.llms({ file: "sitemap.md" })).toBe([
      "# example.com Sitemap",
      "",
      "> Markdown index of every page on example.com. Links point at the raw markdown; append `.md` to any page URL (or set `Accept: text/markdown`) to get it from the page URL instead.",
      "",
      "## Pages",
      "",
      "- [Home](https://example.com/index.md)",
      "",
      "## Blog",
      "",
      "- [About us](https://example.com/blog/about.md)",
      "- [Hello](https://example.com/blog/hello.md)",
      "",
      "## Es",
      "",
      "- [Empezar](https://example.com/es/guides/start.md)",
      "",
      "## Guides",
      "",
      "- [Start](https://example.com/guides/start.md)",
      "",
    ].join("\n"))
  })

  it("serves the three files from the request origin", async () => {
    const content = await site({ llms: true })
    const handler = defineContentLlmsHandler(content)
    const app = new H3().get("/llms.txt", handler).get("/llms-full.txt", handler).get("/sitemap.md", handler)
    const llms = await app.request("https://shop.test/llms.txt")
    expect(llms.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await llms.text()).toContain("- [Hello](https://shop.test/blog/hello.md): The first post.")
    expect((await app.request("https://shop.test/llms-full.txt")).headers.get("content-type")).toBe("text/plain; charset=utf-8")
    const sitemap = await app.request("https://shop.test/sitemap.md")
    expect(sitemap.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(await sitemap.text()).toMatch(/^# shop\.test Sitemap\n/)
    // `llms` turns on the `.md` copies that its links point at.
    expect(content.seo?.markdown).toBe(true)
    expect(await content.markdown("/blog/hello.md")).toBe("# Hello\n\n> The first post.\n\nHello body.\n")
  })

  it("rejects llms without the Markdown copies it links to", () => {
    expect(() => defineContent({ seo: { llms: true, markdown: false }, logger: false })).toThrow(/Remove markdown: false/)
    expect(() => defineContent({ seo: { llms: { title: 1 } as never }, logger: false })).toThrow(/llms.title must be text/)
  })

  it.each(["configured", "call", "request"] as const)("keeps absolute self-canonicals with the %s site", async (origin) => {
    const content = await site({ llms: true, ...(origin === "configured" ? { site: "https://example.com" } : {}) })
    const posts = content.collection("posts")
    await posts.save("self", { data: { title: "Self", seo: { canonical: "https://example.com/blog/self" } }, body: "Self body." })
    await posts.save("elsewhere", { data: { title: "Elsewhere", seo: { canonical: "https://other.test/blog/elsewhere" } }, body: "Elsewhere body." })
    await content.publish({ ids: ["self", "elsewhere"], collection: "posts" })
    expect((await content.sitemap({ site: "https://example.com" })).map(entry => entry.loc)).toContain("https://example.com/blog/self")
    const handler = defineContentLlmsHandler(content)
    const app = new H3().all("/**", handler)
    for (const file of ["llms.txt", "llms-full.txt", "sitemap.md"] as const) {
      const text = origin === "request"
        ? await (await app.request(`https://example.com/${file}`)).text()
        : await content.llms({ file, ...(origin === "call" ? { site: "https://example.com" } : {}) })
      expect(text).toContain(file === "llms-full.txt" ? "# Self\n" : "[Self](https://example.com/blog/self.md)")
      expect(text).not.toContain("Elsewhere")
    }
  })
})

describe("llms files of Sources", { timeout: 30_000 }, () => {
  /** A docs Source with its own frontmatter for "not indexed" and its own Markdown copy with a footer. */
  function docsSite() {
    const pages: Record<string, string> = {
      "index.md": "---\ntitle: Home\n---\nWelcome.\n",
      "guide.md": "---\ntitle: Guide\ndescription: Start here.\n---\n::note\nRead [this](/guide).\n::\n",
      "about.md": "---\ntitle: About\n---\nAbout us.\n",
      "errors/e1.md": "---\ntitle: E1\nindex: false\n---\nAn error.\n",
    }
    const content = defineContent({
      route: false,
      logger: false,
      sources: {
        docs: contentSource(files(pages), {
          url: "/:id",
          label: "Docs",
          seo: ({ data }) => data.index === false ? { noindex: true } : undefined,
          markdown: ({ text, path, site }) => ({ markdown: `# Copy of ${path}\n\n${text.replace(/^---[\s\S]*?---\n/, "").replace(/^::.*\n/gm, "")}`, footer: `\nAll pages: ${site}/llms.txt\n` }),
        }),
      },
      seo: {
        site: "https://example.com",
        markdown: { prefix: "/raw" },
        llms: { title: "Example", description: "Notes.", details: "Rules for agents.", sections: [{ title: "Links", links: [{ title: "API", href: "https://example.com/openapi.json" }] }] },
        mcp: true,
      },
    })
    cleanup.push(() => content.dispose())
    return content
  }

  it("lists Source pages under the Source label, with the extra sections and details", async () => {
    const content = docsSite()
    expect(await content.llms()).toBe([
      "# Example",
      "> Notes.\n\nRules for agents.",
      "## Overview",
      "- [Example](https://example.com/raw/index.md)",
      "## Documentation Sets",
      "- [Example](https://example.com/llms-full.txt): Notes.",
      "## Links",
      "- [API](https://example.com/openapi.json)",
      "## Docs",
      "Every page below is available as raw markdown.",
      "- [About](https://example.com/raw/about.md)\n- [Guide](https://example.com/raw/guide.md): Start here.",
    ].join("\n\n"))
    expect(await content.llms({ file: "sitemap.md" })).toContain("- [Guide](https://example.com/raw/guide.md)")
  })

  it("serves the copy with its footer at the page URL and below the prefix, and joins copies without it", async () => {
    const content = docsSite()
    const copy = "# Copy of /guide\n\nRead [this](/guide).\n\nAll pages: https://example.com/llms.txt\n"
    expect(await content.markdown("/guide.md")).toBe(copy)
    expect(await content.markdown("/raw/guide.md")).toBe(copy)
    // A page that indexes leave out keeps its copy.
    expect(await content.markdown("/raw/errors/e1.md")).toContain("An error.")
    expect(await content.markdown("/raw/missing.md")).toBeNull()
    const full = await content.llms({ file: "llms-full.txt" })
    expect(full).toBe(`${[
      "# Example\n\n> Notes.\n\nRules for agents.",
      "URL: https://example.com/\n\n# Copy of /\n\nWelcome.",
      "URL: https://example.com/about\n\n# Copy of /about\n\nAbout us.",
      "URL: https://example.com/guide\n\n# Copy of /guide\n\nRead [this](/guide).",
    ].join("\n\n---\n\n")}\n`)
    expect((await content.pages()).map(page => page.path).sort()).toEqual(["/", "/about", "/guide"])
    expect(await content.page("/errors/e1")).toMatchObject({ path: "/errors/e1", content: "# Copy of /errors/e1\n\nAn error.\n" })
  })

  it("keeps the path of a mounted site in every URL, but not in page paths", async () => {
    const content = defineContent({
      route: false,
      logger: false,
      sources: { docs: contentSource(files({ "guide.md": "---\ntitle: Guide\n---\nBody.\n" }), { url: "/:id" }) },
      seo: { site: "https://example.com/portal/", markdown: { prefix: "/raw" }, llms: true, mcp: true },
    })
    cleanup.push(() => content.dispose())
    expect(await content.llms({ file: "sitemap.md" })).toContain("- [Guide](https://example.com/portal/raw/guide.md)")
    expect(await content.pages()).toEqual([{ title: "Guide", path: "/guide", url: "https://example.com/portal/guide" }])
    expect(await content.page("/guide")).toMatchObject({ url: "https://example.com/portal/guide" })
  })

  it("rejects page options without a url, and a prefix with a trailing slash", () => {
    expect(() => contentSource(files({}), { label: "Docs" })).toThrow(/needs a url/)
    expect(() => defineContent({ seo: { markdown: { prefix: "/raw/" } }, logger: false })).toThrow(/prefix starts with \//)
  })
})

describe("Markdown negotiation", { timeout: 30_000 }, () => {
  const htmlPage = () => new Response("page", { headers: { "content-type": "text/html; charset=utf-8" } })
  function app(content: Parameters<typeof defineContentMarkdownHandler>[0], page: () => unknown = htmlPage) {
    return new H3().use(defineContentMarkdownHandler(content)).all("/**", page)
  }

  it("preserves downstream and prepared Vary fields, including the wildcard", async () => {
    const content = await site({ markdown: true })
    for (const prepared of ["Cookie", "*"]) {
      for (const vary of ["Accept-Language, Origin", "Accept-Encoding", "*", "accept"]) {
        const headers = { vary, "content-type": "text/html" }
        for (const response of [new Response("page", { headers }), new HTTPResponse("page", { headers })]) {
          const handler = new H3().use((event) => { event.res.headers.set("vary", prepared) })
            .use(defineContentMarkdownHandler(content))
            .all("/**", () => response)
          const result = await handler.request("https://example.com/blog/hello", { headers: { accept: "text/html" } })
          const fields = result.headers.get("vary")!.toLowerCase().split(/,\s*/)
          if (vary === "*" || prepared === "*") expect(fields).toEqual(["*"])
          else expect(new Set(fields)).toEqual(new Set([...vary.toLowerCase().split(/,\s*/), "cookie", "accept"]))
          expect(await result.text()).toBe("page")
        }
      }
    }
  })

  it("negotiates dotted page URLs for GET and HEAD while passing assets through", async () => {
    const content = await site({ markdown: true })
    await content.collection("posts").save("v1.0", { data: { title: "Version 1.0" }, body: "Version body." })
    await content.publish({ ids: ["v1.0"], collection: "posts" })
    await content.collection("articles").save("release", { data: { title: "Version 1.0", slug: "release.v1" }, body: "Version body." })
    await content.publish({ collection: "articles" })
    for (const path of ["/blog/v1.0", "/articles/release.v1"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await app(content).request(`https://example.com${path}`, { method, headers: { accept: "text/markdown" } })
        expect(response.status).toBe(200)
        expect(response.headers.get("vary")).toBe("Accept")
        expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
        expect(await response.text()).toBe(method === "HEAD" ? "" : "# Version 1.0\n\nVersion body.\n")
      }
      const browser = await app(content).request(`https://example.com${path}`, { headers: { accept: "text/html" } })
      expect(browser.headers.get("vary")).toBe("Accept")
    }
    const missing = app(content, () => new Response("gone", { status: 404 }))
    const response = await missing.request("https://example.com/blog/nope.1", { headers: { accept: "text/markdown" } })
    expect(await response.text()).toContain("# 404 Page Not Found")
    const asset = await app(content, () => new Response("body {}", { headers: { "content-type": "text/css" } }))
      .request("https://example.com/style.css", { headers: { accept: "text/markdown" } })
    expect(asset.headers.get("content-type")).toBe("text/css")
    expect(await asset.text()).toBe("body {}")
  })

  it("converts effective H3 404 responses and respects explicit response statuses", async () => {
    const content = await site({ markdown: true })
    const handlers = [
      (event: { res: { status?: number } }) => { event.res.status = 404; return "gone" },
      () => new HTTPResponse("gone", { status: 404 }),
      () => new HTTPError({ status: 404 }),
      (event: { res: { status?: number } }) => { event.res.status = 404; return new HTTPResponse("gone") },
    ]
    for (const handler of handlers) {
      const server = new H3().use(defineContentMarkdownHandler(content)).all("/**", handler)
      for (const path of ["/nope.md", "/nope"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await server.request(`https://example.com${path}`, { method, headers: { accept: "text/markdown" } })
          expect(response.status).toBe(404)
          expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
          expect(await response.text()).toBe(method === "HEAD" ? "" : renderContentMarkdownNotFound({ path, site: "https://example.com", links: [] }))
        }
      }
    }
    for (const result of [new Response("ok"), new HTTPResponse("ok", { status: 200 }), new Response("unavailable", { status: 503 })]) {
      const server = new H3().use(defineContentMarkdownHandler(content)).all("/**", (event) => {
        event.res.status = 404
        return result
      })
      const response = await server.request("https://example.com/nope.md")
      expect(response.status).toBe(result.status)
      expect(await response.text()).toBe(result.status === 503 ? "unavailable" : "ok")
    }
  })

  it("serves the copy at the page URL for Accept: text/markdown, and at the .md twin", async () => {
    const content = await site({ site: "https://example.com", markdown: true })
    const negotiated = await app(content).request("https://example.com/blog/hello", { headers: { accept: "text/markdown" } })
    expect(negotiated.status).toBe(200)
    expect(negotiated.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(negotiated.headers.get("vary")).toBe("Accept")
    expect(await negotiated.text()).toBe("# Hello\n\n> The first post.\n\nHello body.\n")
    const home = await app(content).request("https://example.com/", { headers: { accept: "text/markdown, text/html;q=0.9" } })
    expect(await home.text()).toMatch(/^# Home\n/)
    const twin = await app(content).request("https://example.com/blog/hello.md")
    expect(twin.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(await twin.text()).toBe("# Hello\n\n> The first post.\n\nHello body.\n")
  })

  it("keeps HTML for browsers and marks page responses with Vary: Accept", async () => {
    const content = await site({ site: "https://example.com", markdown: true })
    const browser = await app(content).request("https://example.com/blog/hello", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } })
    expect(await browser.text()).toBe("page")
    expect(browser.headers.get("vary")).toBe("Accept")
    // A draft has no copy: the request goes on to the app.
    expect(await (await app(content).request("https://example.com/blog/draft", { headers: { accept: "text/markdown" } })).text()).toBe("page")
    expect(await (await app(content).request("https://example.com/logo.png", { headers: { accept: "text/markdown" } })).text()).toBe("page")
  })

  it("answers a missing page with the Markdown 404 body when the request asks for Markdown", async () => {
    const content = await site({ site: "https://example.com", markdown: true, sitemap: true, llms: true })
    const missing = app(content, () => {
      throw new HTTPError({ status: 404 })
    })
    const twin = await missing.request("https://example.com/blog/nope.md")
    expect(twin.status).toBe(404)
    expect(twin.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(twin.headers.get("cache-control")).toBe("no-cache")
    expect(await twin.text()).toBe(renderContentMarkdownNotFound({
      path: "/blog/nope.md",
      site: "https://example.com",
      links: [
        { title: "Sitemap (Markdown): every page on the site", href: "/sitemap.md" },
        { title: "llms.txt: index of the documentation for LLMs", href: "/llms.txt" },
        { title: "llms-full.txt: the full documentation as a single file", href: "/llms-full.txt" },
        { title: "Sitemap (XML)", href: "/sitemap.xml" },
      ],
    }))
    const negotiated = await missing.request("https://example.com/blog/draft", { headers: { accept: "text/markdown" } })
    expect(negotiated.status).toBe(404)
    expect(negotiated.headers.get("vary")).toBe("Accept")
    expect(await negotiated.text()).toContain("The page `/blog/draft` does not exist on https://example.com.")
    // A 404 Response and an unmatched route count the same. A browser keeps the app's own 404 page.
    expect((await app(content, () => new Response("gone", { status: 404 })).request("https://example.com/x.md")).headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect((await new H3().use(defineContentMarkdownHandler(content)).request("https://example.com/x.md")).headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    const browser = await missing.request("https://example.com/blog/nope", { headers: { accept: "text/html" } })
    expect(browser.status).toBe(404)
    expect(browser.headers.get("content-type")).not.toContain("markdown")
  })

  it("loads Content to check copies for downstream responses", async () => {
    const content = await site({ site: "https://example.com", markdown: true })
    let loads = 0
    const lazy = app(() => {
      loads++
      return content
    }, () => new Response("body {}", { headers: { "content-type": "text/css" } }))
    expect(await (await lazy.request("https://example.com/style.css")).text()).toBe("body {}")
    expect(await (await lazy.request("https://example.com/blog/hello", { headers: { accept: "text/html" } })).text()).toBe("body {}")
    expect(loads).toBe(2)
    expect(await (await lazy.request("https://example.com/blog/hello.md")).text()).toMatch(/^# Hello\n/)
    expect(loads).toBe(3)
    // An HTML page also loads Content to find its copy.
    expect((await app(() => {
      loads++
      return content
    }).request("https://example.com/blog/hello")).headers.get("link")).toContain("</blog/hello.md>")
    expect(loads).toBe(4)
  })

  it("links the copy from an HTML page that has one", async () => {
    const content = await site({ site: "https://example.com", markdown: true })
    const html = (body = "<p>page</p>", status = 200) => () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
    const page = await app(content, html()).request("https://example.com/blog/hello", { headers: { accept: "text/html" } })
    expect(page.headers.get("link")).toBe("</blog/hello.md>; rel=\"alternate\"; type=\"text/markdown\"")
    expect(page.headers.get("vary")).toBe("Accept")
    expect((await app(content, html()).request("https://example.com/", { method: "HEAD" })).headers.get("link")).toBe("</index.md>; rel=\"alternate\"; type=\"text/markdown\"")
    // A page without a copy does not change with Accept. A page 404 does: a Markdown request gets the Markdown 404.
    const plain = await app(content, html()).request("https://example.com/blog/draft")
    expect(plain.headers.get("link")).toBeNull()
    expect(plain.headers.get("vary")).toBeNull()
    const missing = await app(content, html("<p>gone</p>", 404)).request("https://example.com/blog/nope")
    expect(missing.headers.get("link")).toBeNull()
    expect(missing.headers.get("vary")).toBe("Accept")
    // An existing Link header keeps its values.
    const linked = await app(content, () => new Response("<p>page</p>", { headers: { "content-type": "text/html", link: "</style.css>; rel=preload; as=style" } }))
      .request("https://example.com/blog/hello")
    expect(linked.headers.get("link")).toBe("</style.css>; rel=preload; as=style, </blog/hello.md>; rel=\"alternate\"; type=\"text/markdown\"")
  })

  it("varies every representation at copy-backed URLs, but leaves unrelated responses alone", async () => {
    const content = await site({ site: "https://example.com", markdown: true })
    for (const response of [Response.json({ ok: true }), new Response("body {}", { headers: { "content-type": "text/css" } }), new Response(null, { status: 302, headers: { location: "/blog/hello" } })]) {
      for (const path of ["/blog/hello", "/unrelated"]) {
        const handler = app(content, () => response.clone())
        const result = await handler.request(`https://example.com${path}`, { headers: { accept: "application/json" } })
        expect(result.headers.get("vary")).toBe(path === "/blog/hello" ? "Accept" : null)
        expect(result.headers.get("link")).toBeNull()
        const markdown = await handler.request(`https://example.com${path}`, { headers: { accept: "text/markdown" } })
        expect(markdown.headers.get("vary")).toBe(path === "/blog/hello" ? "Accept" : null)
        if (path === "/blog/hello") expect(await markdown.text()).toMatch(/^# Hello\n/)
        else expect(await markdown.text()).toBe(await response.clone().text())
      }
    }
  })

  it("varies unmatched browser and Markdown 404s", async () => {
    const content = await site({ markdown: true })
    const handler = new H3().use(defineContentMarkdownHandler(content))
    for (const accept of ["text/html", "text/markdown"]) {
      const result = await handler.request("https://example.com/missing", { headers: { accept } })
      expect(result.status).toBe(404)
      expect(result.headers.get("vary")).toBe("Accept")
      expect(result.headers.get("content-type")?.includes("text/markdown")).toBe(accept === "text/markdown")
    }
  })

  it("names the copy and revalidates it with an ETag", async () => {
    const content = await site({ site: "https://example.com", markdown: { prefix: "/raw" } })
    for (const [path, accept, location] of [["/blog/hello.md", "*/*", "/blog/hello.md"], ["/raw/blog/hello.md", "*/*", "/raw/blog/hello.md"], ["/blog/hello", "text/markdown", "/blog/hello.md"]] as const) {
      const first = await app(content).request(`https://example.com${path}`, { headers: { accept } })
      expect(first.status).toBe(200)
      expect(first.headers.get("content-location")).toBe(location)
      const etag = first.headers.get("etag")
      expect(etag).toMatch(/^"[\w-]+"$/)
      const again = await app(content).request(`https://example.com${path}`, { headers: { accept, "if-none-match": `W/"other", ${etag}` } })
      expect(again.status).toBe(304)
      expect(again.headers.get("etag")).toBe(etag)
      expect(await again.text()).toBe("")
      const changed = await app(content).request(`https://example.com${path}`, { headers: { accept, "if-none-match": "\"other\"" } })
      expect(changed.status).toBe(200)
    }
    const head = await app(content).request("https://example.com/blog/hello.md", { method: "HEAD" })
    expect(head.headers.get("etag")).toBe((await app(content).request("https://example.com/blog/hello.md")).headers.get("etag"))
  })

  it("reads Accept quality values", () => {
    expect(acceptsMarkdown("text/markdown")).toBe(true)
    expect(acceptsMarkdown("text/markdown;q=0.5, text/html")).toBe(false)
    expect(acceptsMarkdown("text/html;q=0.5, text/markdown")).toBe(true)
    expect(acceptsMarkdown("text/*")).toBe(false)
    expect(acceptsMarkdown("text/plain, text/markdown;q=0.1")).toBe(true)
    expect(acceptsMarkdown("*/*")).toBe(false)
    expect(acceptsMarkdown(null)).toBe(false)
  })
})

// The expected text below is what `@vite-hub/docs` served on vitehub.dev on 2026-11-11, through nuxt-llms and
// nuxt-agent-discovery. The Content renderers produce the same bytes from the same input, so docs can switch to them.
describe("parity with @vite-hub/docs", () => {
  it("renders the Markdown 404 body byte for byte", async () => {
    const links = [
      ["API catalog: every service document this site publishes", "/.well-known/api-catalog"],
      ["Sitemap (Markdown): every page on the site", "/sitemap.md"],
      ["MCP server card: MCP endpoint at https://vitehub.dev/mcp", "/.well-known/mcp/server-card.json"],
      ["MCP endpoint (streamable HTTP)", "/mcp"],
      ["llms.txt: index of the documentation for LLMs", "/llms.txt"],
      ["llms-full.txt: the full documentation as a single file", "/llms-full.txt"],
      ["Agent skills index: every skill published by this site", "/.well-known/skills/index.json"],
      ["Agent skill: code-review", "/.well-known/skills/code-review/SKILL.md"],
      ["Agent skill: resolving-merge-conflicts", "/.well-known/skills/resolving-merge-conflicts/SKILL.md"],
      ["Agent skill: vitehub", "/.well-known/skills/vitehub/SKILL.md"],
      ["OpenAPI document: every route this site serves to agents", "/openapi.json"],
      ["Sitemap (XML)", "/sitemap.xml"],
    ].map(([title, href]) => ({ title: title!, href: href! }))
    expect(renderContentMarkdownNotFound({ path: "/raw/docs/nope.md", site: "https://vitehub.dev", links })).toBe(await fixture("not-found.md"))
  })

  it("renders the sitemap.md head and sections byte for byte", async () => {
    const page = (path: string, title: string) => ({ path, title, href: `https://vitehub.dev/raw${path}.md` })
    expect(renderContentSitemapMarkdown({
      title: "ViteHub",
      host: "vitehub.dev",
      pages: [
        page("/docs", "ViteHub documentation"),
        page("/about", "About ViteHub"),
        page("/contact", "Contact ViteHub"),
        page("/privacy", "ViteHub privacy"),
        page("/docs/agents", "Agents"),
        page("/docs/agents/actors", "Agent Actors"),
        page("/docs/agents/agent-definitions", "Agent Definitions"),
        page("/docs/agents/agent-drivers", "Agent Drivers"),
        page("/docs/agents/agent-presets", "Reuse Agent Definitions"),
      ],
    })).toBe(await fixture("sitemap-head.md"))
  })

  it("renders llms.txt sections and links byte for byte", async () => {
    const expected = (await fixture("llms-head.txt")).replace(/\n$/, "")
    const blocks = expected.split("\n\n")
    const [description, ...details] = blocks.slice(1, blocks.indexOf("## Overview"))
    const sectionText = blocks[blocks.indexOf("## When to use ViteHub") + 1]!
    const links = blocks.at(-1)!.split("\n").map((line) => {
      const [, title, href, linkDescription] = /^- \[(.+?)\]\((.+?)\): (.+)$/.exec(line)!
      return { title: title!, href: href!, description: linkDescription! }
    })
    expect(renderContentLlms({
      title: "ViteHub",
      description: description!.replace(/^> /, ""),
      details: details.join("\n\n"),
      sections: [
        { title: "Overview", links: [{ title: "ViteHub", href: "https://vitehub.dev/raw/index.md" }] },
        { title: "Documentation Sets", links: [{ title: "ViteHub", href: "https://vitehub.dev/llms-full.txt", description: "Portable Agents for Vite, built on Server Primitives." }] },
        { title: "When to use ViteHub", description: sectionText, links },
      ],
    })).toBe(expected)
  })
})
