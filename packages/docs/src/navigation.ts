import type { DocsManifest, DocsPage, DocsSearchSection, DocsSection } from "./types.ts"

/** A link that the site options add to the shell, such as a tutorials page or a community chat. */
export interface DocsLink {
  label: string
  to: string
  icon?: string
}

/**
 * Icons of the navigation. Frontmatter and `.navigation.yml` icons pass through `aliases`, so a site can show one icon set
 * in its sidebar while pages keep the icons that their authors chose.
 */
export interface DocsIcons {
  /** Rail icon per section id: a `@vite-hub/ui/primitive-rail` icon name or an Iconify name. */
  rail: Record<string, string>
  /** Sidebar icon per section id. It replaces the section's own icon. */
  sections: Record<string, string>
  /** Sidebar icon per page path. It replaces the page's own icon. */
  pages: Record<string, string>
  /** Replacement per icon name. */
  aliases: Record<string, string>
  /**
   * Icon prefix of the sidebar, such as `i-ph-`. An icon outside it that `aliases` does not map shows the fallback icon,
   * so the sidebar keeps one style. Empty allows every icon.
   */
  family: string
  /** Icon of a page without one. */
  page: string
  /** Icon of a section without one. */
  section: string
}

/** One catalog row: the sections of one category, in rail order. */
export interface DocsCatalogGroup {
  category: string
  sections: DocsSection[]
}

/** One group of the sidebar page list. `label` is `null` for pages without a group. */
export interface DocsSidebarGroup {
  label: string | null
  pages: DocsPage[]
}

/** Every page of the manifest, root first. */
export function docsManifestPages(manifest: DocsManifest): DocsPage[] {
  return [...(manifest.root ? [manifest.root] : []), ...manifest.sections.flatMap(section => section.pages), ...manifest.pages]
}

/** A URL path without a trailing slash or `/index`, as the manifest stores it. */
export function normalizeDocsPath(path: string): string {
  return path.replace(/\/index$/, "").replace(/(.)\/+$/, "$1") || "/"
}

/** A docs base with one leading slash and no trailing slash: `docs/` is `/docs`, and `/` stays `/`. */
export function normalizeDocsBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "")
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

/** Whether a path is the docs base or a page under it. Every path is under a base of `/`. */
export function isDocsPath(path: string, base: string): boolean {
  return base === "/" || path === base || path.startsWith(`${base}/`)
}

/** The page at a URL. A trailing slash and `/index` resolve to the same page. */
export function findDocsPage(manifest: DocsManifest, path: string): { page: DocsPage, section: DocsSection | null } | null {
  const normalized = normalizeDocsPath(path)
  for (const section of manifest.sections) {
    const page = section.pages.find(candidate => candidate.path === normalized)
    if (page) return { page, section }
  }
  const page = docsManifestPages(manifest).find(candidate => candidate.path === normalized)
  return page ? { page, section: null } : null
}

/** The section that owns a path, such as `kv` for `/docs/kv/configure`. */
export function docsSectionForPath(manifest: DocsManifest, path: string): DocsSection | null {
  const normalized = normalizeDocsPath(path)
  return manifest.sections.find(section => normalized === section.path || normalized.startsWith(`${section.path}/`)) ?? null
}

/** The page that a section link opens: its Overview, else its first listed page. A section without `index.md` has no page at its own path. */
export function docsSectionHome(section: DocsSection): string {
  return (section.pages.find(page => page.path === section.path) ?? section.pages.find(page => page.navigation) ?? section.pages[0])?.path ?? section.path
}

/** The page that a "Docs" link opens: the docs base page, else the first section. `null` when the site has no docs pages. */
export function docsHomePath(manifest: DocsManifest): string | null {
  if (manifest.root) return manifest.root.path
  const first = manifest.sections[0]
  return first ? docsSectionHome(first) : null
}

/**
 * Whether the site shows the section rail. A rail of three or fewer sections, or of sections without their own icons,
 * shows the same fallback icon several times and carries no information, so the sidebar lists every section instead.
 */
export function docsHasRail(manifest: DocsManifest, icons: Pick<DocsIcons, "rail" | "sections">): boolean {
  if (manifest.sections.length <= 3) return false
  return manifest.sections.some(section => Boolean(section.icon || icons.rail[section.id] || icons.sections[section.id]))
}

/** Sections grouped by category, in the order of `categories`. Sections of other categories are left out. */
export function docsCatalog(manifest: DocsManifest, categories: readonly string[]): DocsCatalogGroup[] {
  return categories
    .map(category => ({ category, sections: manifest.sections.filter(section => section.category === category) }))
    .filter(group => group.sections.length > 0)
}

/**
 * Rail groups: one per catalog category except `railExclude`, then the sections without a known category.
 * Excluded topics stay reachable from the catalog and the start section.
 */
export function docsRailGroups(manifest: DocsManifest, categories: readonly string[], railExclude: readonly string[]): DocsSection[][] {
  const known = new Set(categories)
  return [
    ...docsCatalog(manifest, categories).filter(group => !railExclude.includes(group.category)).map(group => group.sections),
    manifest.sections.filter(section => !section.category || !known.has(section.category)),
  ].filter(sections => sections.length > 0)
}

/** Sidebar rows of a section: listed pages in order, grouped by `navigation.group` in order of first appearance. */
export function docsSidebarGroups(section: DocsSection): DocsSidebarGroup[] {
  const groups = new Map<string | null, DocsPage[]>()
  for (const page of section.pages) {
    if (!page.navigation) continue
    const label = page.group?.trim() || null
    groups.set(label, [...groups.get(label) ?? [], page])
  }
  // A group of one page needs no heading.
  return [...groups].map(([label, pages]) => ({ label: pages.length > 1 ? label : null, pages }))
}

/** Sections listed under Related, in the order that `.navigation.yml` declares them. */
export function docsRelatedSections(manifest: DocsManifest, section: DocsSection): DocsSection[] {
  return section.related
    .map(id => manifest.sections.find(candidate => candidate.id === id))
    .filter((candidate): candidate is DocsSection => candidate !== undefined && candidate.id !== section.id)
}

function iconOf(icons: DocsIcons, icon: string | null, fallback: string): string {
  if (!icon) return fallback
  return icons.aliases[icon] ?? (icon.startsWith(icons.family) ? icon : fallback)
}

/** Sidebar icon of a page. */
export function docsPageIcon(icons: DocsIcons, page: Pick<DocsPage, "path" | "icon">): string {
  return icons.pages[normalizeDocsPath(page.path)] ?? iconOf(icons, page.icon, icons.page)
}

/** Sidebar and catalog icon of a section. */
export function docsSectionIcon(icons: DocsIcons, section: Pick<DocsSection, "id" | "icon">): string {
  return icons.sections[section.id] ?? iconOf(icons, section.icon, icons.section)
}

/** Rail icon of a section. Without a rail entry the rail shows the sidebar icon. */
export function docsRailIcon(icons: DocsIcons, section: Pick<DocsSection, "id" | "icon">): string {
  return icons.rail[section.id] ?? docsSectionIcon(icons, section)
}

/** URL of the raw Markdown twin of a page path, such as `/raw/docs/kv.md`. `/` has `/raw/index.md`. */
export function docsRawPath(path: string): string {
  const normalized = normalizeDocsPath(path)
  return normalized === "/" ? "/raw/index.md" : `/raw${normalized}.md`
}

/** File of the raw Markdown twin in the build's raw folder, such as `docs/kv.md`. */
export function docsRawFile(path: string): string {
  return docsRawPath(path).slice("/raw/".length)
}

/** Cookie that keeps the navigation open beside code panel tutorials. A host that serves prerendered HTML reads it. */
export const docsTutorialNavigationCookie = "vh-tutorial-navigation"

/** Links of the page actions: the Markdown twin and chat tools that read it. */
export interface DocsMarkdownLinks {
  /** Raw Markdown path on the current origin. Local and preview hosts serve it too. */
  markdownPath: string
  /** Canonical raw Markdown URL that external chat tools can fetch. */
  markdownUrl: string
  prompt: string
  chatGptUrl: string
  claudeUrl: string
}

/** Page action links of a docs page. `site.url` is the canonical origin. */
export function docsMarkdownLinks(site: { name: string, url: string }, path: string): DocsMarkdownLinks {
  const markdownPath = docsRawPath(path)
  const markdownUrl = `${site.url}${markdownPath}`
  const prompt = `Read ${markdownUrl} from the ${site.name} documentation. Use it as context to answer my questions and to help me apply it in my project.`
  return {
    markdownPath,
    markdownUrl,
    prompt,
    chatGptUrl: `https://chatgpt.com/?hints=search&q=${encodeURIComponent(prompt)}`,
    claudeUrl: `https://claude.ai/new?q=${encodeURIComponent(prompt)}`,
  }
}

/** Install deeplinks of an HTTP MCP server. The formats match the @nuxtjs/mcp-toolkit deeplink route. */
export function docsMcpInstallLinks(server: { name: string, url: string }): { cursor: string, vscode: string } {
  const config = btoa(JSON.stringify({ type: "http", url: server.url }))
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(server.name)}&config=${encodeURIComponent(config)}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: server.name, type: "http", url: server.url }))}`,
  }
}

/** Words of a search text: lowercase letters and digits. `KV_INVALID_TTL` has the words `kv`, `invalid`, and `ttl`. */
function searchWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

// A query word of 4 to 7 characters can have one typo, a longer word two. Shorter words must match exactly.
function allowedTypos(word: string): number {
  return word.length < 4 ? 0 : word.length < 8 ? 1 : 2
}

/** Edit distance with swapped neighbors as one edit, so "chatgtp" is one edit from "chatgpt". Stops early past `max`. */
function editDistance(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1
  let before: number[] = []
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) value = Math.min(value, before[j - 2]! + 1)
      current[j] = value
      best = Math.min(best, value)
    }
    if (best > max) return max + 1
    before = previous
    previous = current
  }
  return previous[right.length]!
}

// How well one query word matches a list of words: 1 for the same word, less for a prefix, a typo, or a part of a word.
function wordMatch(query: string, words: readonly string[], fuzzy: boolean): number {
  let best = 0
  for (const word of words) {
    if (word === query) return 1
    if (word.startsWith(query)) best = Math.max(best, 0.8)
    else if (query.length >= 3 && word.includes(query)) best = Math.max(best, 0.4)
    else if (fuzzy && best < 0.6) {
      const typos = allowedTypos(query)
      if (typos && editDistance(query, word, typos) <= typos) best = 0.6
    }
  }
  return best
}

interface SearchEntry {
  record: DocsSearchSection
  order: number
  title: string[]
  trail: string[]
  content: string[]
}

// A page title outranks a heading, a heading outranks the headings above it, and those outrank the text.
const pageTitleWeight = 100
const headingWeight = 40
const trailWeight = 15
const contentWeight = 5

/**
 * The search of the docs dialog. Every query word must match the record. Records whose titles match more query words
 * come first, then the higher score: page titles over headings over text. Titles tolerate typos and prefixes, text
 * matches whole words and prefixes. Ties keep the order of the index, which follows the navigation.
 */
export function createDocsSearch(records: readonly DocsSearchSection[]): (query: string, limit: number) => DocsSearchSection[] {
  const entries: SearchEntry[] = records.map((record, order) => ({
    record,
    order,
    title: searchWords(record.title),
    trail: searchWords(record.titles.join(" ")),
    content: [...new Set(searchWords(record.content))],
  }))
  return (query, limit) => {
    const words = [...new Set(searchWords(query))]
    if (!words.length) return []
    const hits: { entry: SearchEntry, inTitles: number, score: number }[] = []
    for (const entry of entries) {
      const titleWeight = entry.record.level === 1 ? pageTitleWeight : headingWeight
      let inTitles = 0
      let score = 0
      let missed = false
      for (const word of words) {
        const title = wordMatch(word, entry.title, true) * titleWeight
        const trail = wordMatch(word, entry.trail, true) * trailWeight
        const content = wordMatch(word, entry.content, false) * contentWeight
        const best = Math.max(title, trail, content)
        if (!best) {
          missed = true
          break
        }
        if (title || trail) inTitles++
        score += best
      }
      if (missed) continue
      // A title that is only the query, such as "KV" for "kv", is the page the reader asked for. Half a title weight keeps
      // a heading named "Install" below the page "Installation".
      if (entry.title.join(" ") === words.join(" ")) score += titleWeight / 2
      hits.push({ entry, inTitles, score })
    }
    hits.sort((left, right) =>
      right.inTitles - left.inTitles
      || right.score - left.score
      || left.entry.title.length - right.entry.title.length
      || left.entry.order - right.entry.order)
    return hits.slice(0, limit).map(hit => hit.entry.record)
  }
}
