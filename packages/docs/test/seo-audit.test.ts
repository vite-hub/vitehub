import { describe, expect, it } from "vitest"

import { docsSeoProblems, docsSitemapPaths, readDocsSeoPage } from "../src/seo-audit.ts"

const origin = "https://acme.dev"
const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ")

function html(options: { title?: string, description?: string, canonical?: string, robots?: string, refresh?: boolean, og?: false, body?: string } = {}) {
  const head = [
    options.title === undefined ? "<title>Key-value storage for apps · Acme</title>" : `<title>${options.title}</title>`,
    options.description === undefined ? "<meta name=\"description\" content=\"Store small values by key, read them back from a route, and choose the driver of each host.\">" : `<meta name="description" content="${options.description}">`,
    options.canonical ? `<link rel="canonical" href="${options.canonical}">` : "",
    options.robots ? `<meta name="robots" content="${options.robots}">` : "",
    options.refresh ? "<meta http-equiv=\"refresh\" content=\"0; url=/learn\">" : "",
    options.og === false ? "" : "<meta property=\"og:title\" content=\"KV\"><meta property=\"og:type\" content=\"article\"><meta property=\"og:image\" content=\"https://acme.dev/og.png\"><meta property=\"og:url\" content=\"https://acme.dev/docs/kv\">",
  ].join("")
  return `<!DOCTYPE html><html><head>${head}</head><body>${options.body ?? `<h1>KV</h1><p>${words(200)}</p><a href="/">Home</a>`}</body></html>`
}

function page(path: string, options: Parameters<typeof html>[0] = {}) {
  return readDocsSeoPage(path, html(options), origin)
}

describe("readDocsSeoPage", () => {
  it("reads the title, the description, the headings, the text, and the app links", () => {
    const read = readDocsSeoPage("/docs/kv", html({
      title: "KV &amp; Blob · Acme",
      canonical: "https://acme.dev/docs/kv",
      body: `<nav><a href="/docs">Docs</a></nav><h1>KV</h1><h3>Skipped</h3><p>one two</p><script>const hidden = "not words"</script>`
        + `<a href="blob?x=1#top">Blob</a><a href="https://acme.dev/about/">About</a><a href="https://elsewhere.dev">Out</a><a href="mailto:a@acme.dev">Mail</a>`,
    }), origin)
    expect(read).toMatchObject({
      title: "KV & Blob · Acme",
      canonical: "/docs/kv",
      h1: 1,
      headingSkip: "h1 → h3",
      noindex: false,
      redirect: false,
      links: ["/docs", "/docs/blob", "/about"],
    })
    // Inline tags join their text, as in a browser: "BlobAboutOutMail" is one word.
    expect(read.words).toBe(6)
  })

  it("reads paths below the app base", () => {
    const read = readDocsSeoPage("/docs/kv", html({ canonical: "https://acme.dev/help/docs/kv", body: "<a href=\"/help/about\">About</a><a href=\"/other\">Other</a>" }), "https://acme.dev/help")
    expect(read.canonical).toBe("/docs/kv")
    expect(read.links).toEqual(["/about"])
    expect(docsSitemapPaths("<urlset><url><loc>https://acme.dev/help/docs/kv</loc></url></urlset>", "https://acme.dev/help")).toEqual(["/docs/kv"])
  })

  it("treats nested example previews as separate heading outlines", () => {
    const read = page("/docs/kv", {
      body: '<h1>Page</h1><h2>Examples</h2><div class="extra docs-example-preview"><div><h1>Demo</h1><h4>Demo heading</h4></div></div>'
        + '<div style="display:none"><div class="docs-example-preview"><h1>Inactive demo</h1></div></div><h3>Next page heading</h3>',
    })
    expect(read.h1).toBe(1)
    expect(read.headingSkip).toBeNull()
    expect(page("/docs/kv", { body: '<h1>Page</h1><div class="docs-example-preview"><h1>Demo</h1></div><h4>Invalid page heading</h4>' }).headingSkip).toBe("h1 → h4")
  })
})

describe("docsSeoProblems", () => {
  const home = page("/", { title: "Acme: storage for Vite apps", description: "Acme adds storage, queues, and jobs to Vite apps, and runs the same code on Node, Cloudflare, and Vercel.", body: `<h1>Acme</h1><p>${words(200)}</p><a href="/docs/kv">KV</a><a href="/docs/blob">Blob</a>` })

  it("accepts a site whose pages pass every check", () => {
    const blob = page("/docs/blob", { title: "Blob storage for files and uploads · Acme", description: "Upload files, list them by prefix, and serve them from a route on Node, Cloudflare, and Vercel hosts." })
    expect(docsSeoProblems([home, page("/docs/kv"), blob], ["/", "/docs/kv", "/docs/blob"])).toEqual([])
  })

  it("names sitemap URLs that redirect or were not prerendered", () => {
    const guides = page("/guides", { refresh: true })
    expect(docsSeoProblems([home, page("/docs/kv"), guides], ["/", "/docs/kv", "/guides", "/playground"])).toEqual([
      "/guides is in the sitemap, but it redirects. List the page that it redirects to instead.",
      "/playground is in the sitemap, but the build did not prerender it as a page. Remove it from the sitemap, or make it a page.",
    ])
  })

  it("names pages outside the title, description, heading, and text limits", () => {
    const thin = page("/docs/thin", {
      title: "Thin",
      description: "Too short.",
      body: `<h1>One</h1><h1>Two</h1><h4>Deep</h4><p>${words(20)}</p>`,
    })
    const linked = page("/", { title: "Acme: storage for Vite apps", description: "Acme adds storage, queues, and jobs to Vite apps, and runs the same code on Node, Cloudflare, and Vercel.", body: `<h1>Acme</h1><p>${words(200)}</p><a href="/docs/thin">Thin</a>` })
    expect(docsSeoProblems([linked, thin], [])).toEqual([
      "/docs/thin has a title of 4 characters, \"Thin\". Keep it between 10 and 60, with `seo.title` when the heading must stay.",
      "/docs/thin has a description of 10 characters. Keep it between 70 and 160.",
      "/docs/thin has 2 h1 headings. Give it one.",
      "/docs/thin skips a heading level, h1 → h4. Go down one level at a time.",
      "/docs/thin has 23 words. Write at least 150, or merge it into another page.",
    ])
  })

  it("names pages that share a title or a description, and pages that nothing links to", () => {
    const chat = page("/docs/ui/chat")
    expect(docsSeoProblems([home, page("/docs/kv"), chat], [])).toEqual([
      "/docs/kv, /docs/ui/chat share the title \"Key-value storage for apps · Acme\". Give each page its own.",
      expect.stringMatching(/^\/docs\/kv, \/docs\/ui\/chat share the description "Store small values/),
      "No page links to /docs/ui/chat. Link it from the navigation, the footer, or a related page.",
    ])
  })

  it("leaves out copies: noindex pages and pages whose canonical is another page", () => {
    const lesson = page("/learn/kv", { canonical: "https://acme.dev/docs/kv" })
    const draft = page("/docs/draft", { robots: "noindex, follow", title: "Draft" })
    expect(docsSeoProblems([home, page("/docs/kv"), lesson, draft], [])).toEqual([])
  })

  it("names pages over the size limit, links to redirects and endpoints, and incomplete Open Graph tags", () => {
    const big = page("/docs/codes", { body: `<h1>Codes</h1><p>${words(200)}</p><table>${"<tr><td class=\"py-3 px-4 text-sm\">x</td></tr>".repeat(60_000)}</table>` })
    expect(big.bytes).toBeGreaterThan(2 * 1024 * 1024)
    const guides = page("/guides", { refresh: true })
    const links = page("/docs/links", { body: `<h1>Links</h1><p>${words(200)}</p><a href="/guides">Guides</a><a href="/mcp">MCP</a><a href="/">Home</a>` })
    const bare = page("/docs/bare", { og: false })
    expect(bare.openGraphMissing).toEqual(["og:title", "og:type", "og:image", "og:url"])
    // Attribute order and empty values: `content` first counts, an empty `content` does not.
    const reordered = readDocsSeoPage("/docs/reordered", html({ og: false }).replace("</head>", '<meta content="KV" property="og:title"><meta content="article" property="og:type"><meta content="https://acme.dev/og.png" property="og:image"><meta property="og:url" content=""></head>'), origin)
    expect(reordered.openGraphMissing).toEqual(["og:url"])
    const problems = docsSeoProblems([home, big, guides, links, bare], [], { endpoints: ["/mcp"] })
    expect(problems).toContain("/docs/codes has 2.6 MiB of HTML, and crawlers read only the first 2.0 MiB. Split the page, or show long lists with a component that renders less markup than a Markdown table.")
    expect(problems).toContain("/docs/links links to /guides, which redirects. Link to the page that it redirects to.")
    expect(problems).toContain("/docs/links links to /mcp, an endpoint that answers a browser with an error. Write the URL as code, or link to the page that explains it.")
    expect(problems).toContain("/docs/bare has no og:title, og:type, og:image, og:url tag. Share previews need og:title, og:type, og:image, og:url: set `seo.image` instead of `false` for the image, and keep `site.url` set for the URL.")
  })
})
