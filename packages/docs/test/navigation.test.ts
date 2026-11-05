import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import {
  docsCatalog,
  docsHasRail,
  docsHomePath,
  docsManifestPages,
  docsMarkdownLinks,
  docsMcpInstallLinks,
  docsPageIcon,
  docsRailGroups,
  docsRailIcon,
  docsRawPath,
  docsRawSectionLinks,
  docsRelatedSections,
  docsSectionForPath,
  docsSectionHome,
  docsSectionIcon,
  docsSidebarGroups,
  findDocsPage,
  normalizeDocsBase,
  normalizeDocsPath,
  type DocsIcons,
  isDocsPath,
} from "../src/navigation.ts"

const manifest = createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" })
const categories = ["Start", "Data", "Reference"]

function section(id: string) {
  const found = manifest.sections.find(candidate => candidate.id === id)
  if (!found) throw new Error(`Missing fixture section ${id}`)
  return found
}

describe("docs manifest", () => {
  it("orders sections by `.navigation.yml` and drops folders without pages", () => {
    expect(manifest.sections.map(candidate => candidate.id)).toEqual(["start", "kv", "blob", "reference", "misc"])
    expect(section("kv").title).toBe("KV")
    expect(section("start").title).toBe("Start here")
    expect(section("misc").category).toBeNull()
  })

  it("lists the root page first and the pages outside the base last", () => {
    expect(manifest.root?.path).toBe("/docs")
    expect(manifest.pages.map(page => page.path)).toEqual(["/", "/about"])
    const paths = docsManifestPages(manifest).map(page => page.path)
    expect(paths[0]).toBe("/docs")
    expect(paths.slice(-2)).toEqual(["/", "/about"])
  })

  it("reads the layout and the outline default from frontmatter", () => {
    expect(manifest.root).toMatchObject({ layout: "landing", toc: false })
    expect(findDocsPage(manifest, "/docs/kv")?.page).toMatchObject({ layout: "landing", toc: false, title: "Overview", sourceTitle: "KV" })
    expect(findDocsPage(manifest, "/docs/kv/configure")?.page).toMatchObject({ layout: "article", toc: true })
  })
})

describe("docs paths", () => {
  it("knows which paths belong to the docs base, also at the site root", () => {
    expect(isDocsPath("/docs", "/docs")).toBe(true)
    expect(isDocsPath("/docs/kv", "/docs")).toBe(true)
    expect(isDocsPath("/docsearch", "/docs")).toBe(false)
    expect(isDocsPath("/guide", "/")).toBe(true)
  })

  it("writes the docs base one way, as the manifest and the routes read it", () => {
    for (const base of ["/docs", "/docs/", "docs", "docs/"]) expect(normalizeDocsBase(base)).toBe("/docs")
    expect(normalizeDocsBase("/")).toBe("/")
  })

  it("resolves trailing slashes and `/index` to the same page", () => {
    expect(normalizeDocsPath("/docs/kv/")).toBe("/docs/kv")
    expect(normalizeDocsPath("/docs/kv/index")).toBe("/docs/kv")
    expect(normalizeDocsPath("/")).toBe("/")
    for (const path of ["/docs/kv", "/docs/kv/", "/docs/kv/index"]) {
      expect(findDocsPage(manifest, path)).toMatchObject({ page: { path: "/docs/kv" }, section: { id: "kv" } })
    }
  })

  it("finds pages without a section", () => {
    expect(findDocsPage(manifest, "/docs")).toMatchObject({ page: { path: "/docs" }, section: null })
    expect(findDocsPage(manifest, "/about/")).toMatchObject({ page: { path: "/about" }, section: null })
    expect(findDocsPage(manifest, "/docs/kv/missing")).toBeNull()
  })

  it("finds the section that owns a path", () => {
    expect(docsSectionForPath(manifest, "/docs/kv/configure/")?.id).toBe("kv")
    expect(docsSectionForPath(manifest, "/docs/kv")?.id).toBe("kv")
    // A shared prefix is not a parent folder.
    expect(docsSectionForPath(manifest, "/docs/kvx")).toBeNull()
    expect(docsSectionForPath(manifest, "/docs")).toBeNull()
    expect(docsSectionForPath(manifest, "/about")).toBeNull()
  })

  it("maps a page to its raw Markdown twin", () => {
    expect(docsRawPath("/")).toBe("/raw/index.md")
    expect(docsRawPath("/docs/")).toBe("/raw/docs.md")
    expect(docsRawPath("/docs/kv/configure")).toBe("/raw/docs/kv/configure.md")
  })
})

describe("docs catalog and rail", () => {
  it("groups sections by category in option order and leaves out other categories", () => {
    expect(docsCatalog(manifest, categories).map(group => [group.category, group.sections.map(candidate => candidate.id)])).toEqual([
      ["Start", ["start"]],
      ["Data", ["kv", "blob"]],
      ["Reference", ["reference"]],
    ])
    expect(docsCatalog(manifest, ["Data", "Start", "Unused"]).map(group => group.category)).toEqual(["Data", "Start"])
  })

  it("keeps excluded categories out of the rail and puts sections without a known category last", () => {
    const rail = docsRailGroups(manifest, categories, ["Reference"]).map(group => group.map(candidate => candidate.id))
    expect(rail).toEqual([["start"], ["kv", "blob"], ["misc"]])
    // A category that the options do not list counts as unknown.
    expect(docsRailGroups(manifest, ["Start"], []).map(group => group.map(candidate => candidate.id))).toEqual([["start"], ["kv", "blob", "reference", "misc"]])
  })
})

describe("docs home links", () => {
  // The playground is a small site: no `content/docs/index.md`, two sections without icons, and `guides` has no Overview.
  const small = createDocsManifest({ dir: resolve(import.meta.dirname, "../../../playground/docs/content"), base: "/docs" })

  it("opens the docs base page when it exists", () => {
    expect(docsHomePath(manifest)).toBe("/docs")
  })

  it("opens the first section when the docs base has no page, and nothing without docs pages", () => {
    expect(small.root).toBeNull()
    expect(docsHomePath(small)).toBe("/docs/getting-started")
    expect(docsHomePath({ base: "/docs", root: null, sections: [], pages: [] })).toBeNull()
  })

  it("opens the first listed page of a section without an Overview", () => {
    expect(docsSectionHome(section("kv"))).toBe("/docs/kv")
    const guides = small.sections.find(candidate => candidate.id === "guides")
    expect(guides && docsSectionHome(guides)).toBe("/docs/guides/configuration")
  })
})

describe("docs rail", () => {
  const noIcons = { rail: {}, sections: {} }
  const small = createDocsManifest({ dir: resolve(import.meta.dirname, "../../../playground/docs/content"), base: "/docs" })
  const vitehub = createDocsManifest({ dir: resolve(import.meta.dirname, "../../../docs/content"), base: "/docs" })

  it("drops the rail for three sections or fewer", () => {
    expect(docsHasRail(small, noIcons)).toBe(false)
    expect(docsHasRail({ ...manifest, sections: manifest.sections.slice(0, 3) }, { rail: { kv: "kv" }, sections: {} })).toBe(false)
  })

  it("drops the rail when no section has its own icon", () => {
    const plain = { ...manifest, sections: manifest.sections.map(candidate => ({ ...candidate, icon: null })) }
    expect(docsHasRail(plain, noIcons)).toBe(false)
    expect(docsHasRail(plain, { rail: { kv: "kv" }, sections: {} })).toBe(true)
  })

  it("keeps the rail of vitehub.dev", () => {
    expect(vitehub.sections.length).toBeGreaterThan(20)
    expect(docsHasRail(vitehub, noIcons)).toBe(true)
  })
})

describe("docs sidebar", () => {
  it("lists navigable pages in order and names groups with more than one page", () => {
    expect(docsSidebarGroups(section("kv")).map(group => [group.label, group.pages.map(page => page.title)])).toEqual([
      [null, ["Overview", "Get started"]],
      ["Guides", ["Configure KV", "Expire keys"]],
      [null, ["Server API"]],
    ])
  })

  it("ends a raw page with its section in sidebar order, the next page, and the index", () => {
    const site = "https://docs.example.com/portal"
    expect(docsRawSectionLinks(manifest, "/docs/kv/configure", site)).toBe(`
<!-- vitehub-docs:section-links -->
## In this section

- [Overview](${site}/raw/docs/kv.md)
- [Get started](${site}/raw/docs/kv/get-started.md)
- Guides
  - [Configure KV](${site}/raw/docs/kv/configure.md) (this page)
  - [Expire keys](${site}/raw/docs/kv/ttl.md)
- [Server API](${site}/raw/docs/kv/api.md)

Next: [Expire keys](${site}/raw/docs/kv/ttl.md)

All pages: [llms.txt](${site}/llms.txt)
`)
    // Another group shows as one link to its first page.
    const api = docsRawSectionLinks(manifest, "/docs/kv/api", site)
    expect(api).toContain(`- [Guides](${site}/raw/docs/kv/configure.md)\n- [Server API](${site}/raw/docs/kv/api.md) (this page)`)
    expect(api).not.toContain("Expire keys")
    expect(api).not.toContain("Next:")
  })

  it("keeps only the index link for a page without other pages beside it", () => {
    const index = "\n<!-- vitehub-docs:section-links -->\nAll pages: [llms.txt](https://docs.example.com/llms.txt)\n"
    // A section of one page, the docs root, a page outside the base, and an unlisted page.
    for (const path of ["/docs/blob", "/docs", "/about"]) expect(docsRawSectionLinks(manifest, path, "https://docs.example.com")).toBe(index)
    expect(docsRawSectionLinks(manifest, "/docs/kv/draft", "https://docs.example.com")).not.toContain("(this page)")
  })

  it("lists related sections in declared order without the section itself or unknown ids", () => {
    expect(docsRelatedSections(manifest, section("kv")).map(candidate => candidate.id)).toEqual(["blob", "start"])
    expect(docsRelatedSections(manifest, section("blob"))).toEqual([])
  })
})

describe("docs icons", () => {
  const icons: DocsIcons = {
    rail: { kv: "kv" },
    sections: { blob: "i-ph-archive-light" },
    pages: { "/docs/kv/configure": "i-ph-gear-light" },
    aliases: { "i-lucide-database": "i-ph-database-light" },
    family: "i-ph-",
    page: "i-ph-file-light",
    section: "i-ph-folder-light",
  }

  it("prefers explicit maps, then aliases, then icons inside the family", () => {
    expect(docsSectionIcon(icons, section("blob"))).toBe("i-ph-archive-light")
    expect(docsSectionIcon(icons, section("kv"))).toBe("i-ph-database-light")
    expect(docsSectionIcon(icons, section("start"))).toBe("i-ph-rocket-light")
    expect(docsSectionIcon(icons, section("misc"))).toBe("i-ph-folder-light")
    expect(docsPageIcon(icons, { path: "/docs/kv/configure/", icon: null })).toBe("i-ph-gear-light")
    expect(docsPageIcon(icons, { path: "/docs/kv/api", icon: null })).toBe("i-ph-file-light")
  })

  it("shows the fallback for an icon outside the family that no alias maps", () => {
    expect(docsPageIcon(icons, { path: "/docs/kv/api", icon: "i-lucide-code" })).toBe("i-ph-file-light")
    expect(docsSectionIcon(icons, { id: "other", icon: "i-lucide-box" })).toBe("i-ph-folder-light")
    expect(docsSectionIcon({ ...icons, family: "" }, { id: "other", icon: "i-lucide-box" })).toBe("i-lucide-box")
  })

  it("accepts every prefix of a family list", () => {
    const mixed = { ...icons, family: ["i-ph-", "i-vitehub-"] }
    expect(docsSectionIcon(mixed, { id: "queue", icon: "i-vitehub-queue" })).toBe("i-vitehub-queue")
    expect(docsPageIcon(mixed, { path: "/docs/kv/api", icon: "i-ph-code-light" })).toBe("i-ph-code-light")
    expect(docsSectionIcon(mixed, { id: "other", icon: "i-lucide-box" })).toBe("i-ph-folder-light")
    expect(docsSectionIcon({ ...icons, family: [] }, { id: "other", icon: "i-lucide-box" })).toBe("i-lucide-box")
  })

  it("uses the rail map and falls back to the sidebar icon", () => {
    expect(docsRailIcon(icons, section("kv"))).toBe("kv")
    expect(docsRailIcon(icons, section("blob"))).toBe("i-ph-archive-light")
  })
})

describe("docs page actions", () => {
  const site = { name: "Fixture", url: "https://docs.example.com" }

  it("points every route form of a page at one raw Markdown URL", () => {
    for (const path of ["/docs/kv/configure", "/docs/kv/configure/"]) {
      expect(docsMarkdownLinks(site, path)).toMatchObject({
        markdownPath: "/raw/docs/kv/configure.md",
        markdownUrl: "https://docs.example.com/raw/docs/kv/configure.md",
      })
    }
    expect(docsMarkdownLinks(site, "/docs/").markdownUrl).toBe("https://docs.example.com/raw/docs.md")
  })

  it("opens ChatGPT and Claude with a prompt that names the site and the canonical raw URL", () => {
    const links = docsMarkdownLinks(site, "/docs/kv")
    expect(links.prompt).toBe(
      "Read https://docs.example.com/raw/docs/kv.md from the Fixture documentation. Use it as context to answer my questions and to help me apply it in my project.",
    )

    const chatGpt = new URL(links.chatGptUrl)
    expect(chatGpt.origin).toBe("https://chatgpt.com")
    expect(chatGpt.searchParams.get("hints")).toBe("search")
    expect(chatGpt.searchParams.get("q")).toBe(links.prompt)

    const claude = new URL(links.claudeUrl)
    expect(`${claude.origin}${claude.pathname}`).toBe("https://claude.ai/new")
    expect(claude.searchParams.get("q")).toBe(links.prompt)
  })

  it("builds Cursor and VS Code install links for an HTTP MCP server", () => {
    const server = { name: "fixture", url: "https://docs.example.com/mcp" }
    const links = docsMcpInstallLinks(server)

    const cursor = new URL(links.cursor)
    expect(`${cursor.protocol}//${cursor.host}${cursor.pathname}`).toBe("cursor://anysphere.cursor-deeplink/mcp/install")
    expect(cursor.searchParams.get("name")).toBe("fixture")
    expect(JSON.parse(atob(cursor.searchParams.get("config") ?? ""))).toEqual({ type: "http", url: server.url })

    expect(links.vscode.startsWith("vscode:mcp/install?")).toBe(true)
    expect(JSON.parse(decodeURIComponent(links.vscode.slice("vscode:mcp/install?".length)))).toEqual({ name: "fixture", type: "http", url: server.url })
  })
})


describe("docs URLs below an application base", () => {
  it("prefixes fetches, canonical and alternate paths, and raw page actions exactly once", async () => {
    const { docsAppPath, docsRawPath, docsMarkdownLinks } = await import("../src/navigation.ts")
    expect(docsAppPath("/api/_docs/search.json", "/portal/")).toBe("/portal/api/_docs/search.json")
    expect(docsAppPath("/docs/kv", "/portal/")).toBe("/portal/docs/kv")
    expect(docsAppPath(docsRawPath("/docs/kv"), "/portal/")).toBe("/portal/raw/docs/kv.md")
    expect(docsAppPath("/", "/portal/")).toBe("/portal/")
    expect(docsAppPath("https://cdn.example.com/logo.svg", "/portal/")).toBe("https://cdn.example.com/logo.svg")
    expect(docsMarkdownLinks({ name: "Docs", url: "https://docs.example.com" }, "/docs/kv", "/portal/")).toMatchObject({
      markdownPath: "/portal/raw/docs/kv.md", markdownUrl: "https://docs.example.com/portal/raw/docs/kv.md",
    })
  })
})
