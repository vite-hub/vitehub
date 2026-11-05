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
   * Icon prefix of the sidebar, such as `i-ph-`, or several prefixes, such as `["i-ph-", "i-vitehub-"]`. An icon outside
   * them that `aliases` does not map shows the fallback icon, so the sidebar keeps one style. `""` or `[]` allows every icon.
   */
  family: string | string[]
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

/**
 * A rail entry that holds several sections, such as every component package of a library. The rail shows one item
 * for the group, and its sidebar lists every section of the group.
 */
export interface DocsGroup {
  /** Rail label, and the value of `group` in the `.navigation.yml` of a member section. */
  title: string
  /** Rail icon. Without it, the rail shows the icon of the first section of the group. */
  icon?: string
  /** Ids of member sections. A section also joins with `group: <title>` in its `.navigation.yml`. */
  sections?: string[]
}

/** One rail item: a section alone, or the sections of a group, in rail order. */
export interface DocsRailEntry {
  title: string
  /** Icon of the group. `null` shows the rail icon of the first section. */
  icon: string | null
  sections: DocsSection[]
}

/** A section in a sidebar that lists several sections: its home page, then its other listed pages by group. */
export interface DocsSidebarSection {
  section: DocsSection
  home: DocsPage | null
  groups: DocsSidebarGroup[]
}

/** One block of a sidebar that lists several sections. `category` is `null` when all the sections share one category. */
export interface DocsSidebarSectionBlock {
  category: string | null
  sections: DocsSidebarSection[]
}

/** Every page of the manifest, root first. */
export function docsManifestPages(manifest: DocsManifest): DocsPage[] {
  return [...(manifest.root ? [manifest.root] : []), ...manifest.sections.flatMap(section => section.pages), ...manifest.pages]
}

/** A URL path without a trailing slash or `/index`, as the manifest stores it. */
export function normalizeDocsPath(path: string): string {
  return path.replace(/\/index$/, "").replace(/(.)\/+$/, "$1") || "/"
}

/** A browser URL for an app-relative route or asset. Router links keep their app-relative paths. */
export function docsAppPath(path: string, appBase = "/"): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path
  const base = appBase.replace(/^\/+|\/+$/g, "")
  return base ? `/${base}${path}` : path
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
 * Whether the site shows the section rail. A rail of three or fewer items, or of sections without their own icons,
 * shows the same fallback icon several times and carries no information, so the sidebar lists every section instead.
 * The sections of one group count as one item. Only items placed in the rail count.
 */
export function docsHasRail(manifest: DocsManifest, icons: Pick<DocsIcons, "rail" | "sections">, groups: readonly DocsGroup[] = [], options: { categories: readonly string[], railExclude: readonly string[] } = { categories: [], railExclude: [] }): boolean {
  const entries = docsRailEntries(manifest, { ...options, groups }).flat()
  // Each item shows its group's icon, else the icon of its first section, as the rail draws it.
  return entries.length > 3 && entries.some((entry) => {
    const section = entry.sections[0]!
    return Boolean(entry.icon || section.icon || icons.rail[section.id] || icons.sections[section.id])
  })
}

/** Title of the group of a section: the `groups` entry that lists it, else the `group` of its `.navigation.yml`. */
export function docsSectionGroup(section: Pick<DocsSection, "id" | "group">, groups: readonly DocsGroup[]): string | null {
  return groups.find(group => group.sections?.includes(section.id))?.title ?? section.group ?? null
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

/**
 * Rail items in rail groups: `docsRailGroups()`, with the sections of one group in one item. The item takes the place
 * of the first section of its group that the rail shows. It holds every section of the group in manifest order, also
 * one whose category `railExclude` leaves out of the rail.
 */
export function docsRailEntries(manifest: DocsManifest, options: { categories: readonly string[], railExclude: readonly string[], groups: readonly DocsGroup[] }): DocsRailEntry[][] {
  const railGroups = docsRailGroups(manifest, options.categories, options.railExclude)
  const members = new Map<string, DocsSection[]>()
  for (const section of manifest.sections) {
    const title = docsSectionGroup(section, options.groups)
    if (title !== null) members.set(title, [...members.get(title) ?? [], section])
  }
  const placed = new Set<string>()
  return railGroups.map(sections => sections.flatMap((section): DocsRailEntry[] => {
    const title = docsSectionGroup(section, options.groups)
    if (title === null) return [{ title: section.title, icon: null, sections: [section] }]
    if (placed.has(title)) return []
    placed.add(title)
    return [{ title, icon: options.groups.find(group => group.title === title)?.icon ?? null, sections: members.get(title)! }]
  })).filter(entries => entries.length > 0)
}

/** The rail item of a section, or `null` for a section outside every group that the rail leaves out. */
export function docsRailEntry(manifest: DocsManifest, options: { categories: readonly string[], railExclude: readonly string[], groups: readonly DocsGroup[] }, section: DocsSection): DocsRailEntry | null {
  return docsRailEntries(manifest, options).flat().find(entry => entry.sections.some(candidate => candidate.id === section.id)) ?? null
}

/**
 * Blocks of a sidebar that lists several sections, such as a group or a site without a rail. Each section shows its
 * home page, then its other listed pages. When the sections span several categories, each run of one category is a
 * block with that category as its heading.
 */
export function docsSidebarSections(sections: readonly DocsSection[]): DocsSidebarSectionBlock[] {
  const headed = new Set(sections.map(section => section.category)).size > 1
  const blocks: DocsSidebarSectionBlock[] = []
  for (const section of sections) {
    const homePath = docsSectionHome(section)
    const home = section.pages.find(page => page.path === homePath && page.navigation) ?? null
    const groups = docsSidebarGroups({ ...section, pages: section.pages.filter(page => page !== home) })
    const entry = { section, home, groups }
    const category = headed ? section.category : null
    const last = blocks.at(-1)
    if (last && last.category === category) last.sections.push(entry)
    else blocks.push({ category, sections: [entry] })
  }
  return blocks
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
  const family = typeof icons.family === "string" ? [icons.family] : icons.family
  const allowed = family.length === 0 || family.some(prefix => icon.startsWith(prefix))
  return icons.aliases[icon] ?? (allowed ? icon : fallback)
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

/** Identifies the generated footer even when runtime config overrides its build-time URLs. */
export const docsRawSectionLinksMarker = "\n<!-- vitehub-docs:section-links -->\n"

/**
 * The end of a page's raw Markdown copy: the pages of its section in sidebar order, the next page, and the llms.txt
 * index. An agent that reads one page finds the pages beside it without loading the index of the whole site. A sidebar
 * group other than the page's own shows as one link to its first page, so a large section stays short.
 * `siteUrl` is the public origin with the app base, such as `https://docs.example.com/portal`.
 */
export function docsRawSectionLinks(manifest: DocsManifest, path: string, siteUrl: string): string {
  const found = findDocsPage(manifest, path)
  const section = found?.section
  const pages = section?.pages.filter(page => page.navigation) ?? []
  const index = pages.findIndex(page => page.path === found?.page.path)
  const url = (page: DocsPage) => `${siteUrl}${docsRawPath(page.path)}`
  const item = (page: DocsPage) => `[${page.title}](${url(page)})${page === pages[index] ? " (this page)" : ""}`
  const blocks: string[] = []
  // A section of one page has nothing beside it.
  if (section && pages.length > 1) {
    const lines = docsSidebarGroups(section).flatMap(({ label, pages: grouped }) => {
      if (label === null) return grouped.map(page => `- ${item(page)}`)
      if (!grouped.includes(pages[index]!)) return [`- [${label}](${url(grouped[0]!)})`]
      return [`- ${label}`, ...grouped.map(page => `  - ${item(page)}`)]
    })
    blocks.push("## In this section", lines.join("\n"))
    const next = index >= 0 ? pages[index + 1] : undefined
    if (next) blocks.push(`Next: [${next.title}](${url(next)})`)
  }
  blocks.push(`All pages: [llms.txt](${siteUrl}/llms.txt)`)
  return `${docsRawSectionLinksMarker}${blocks.join("\n\n")}\n`
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
export function docsMarkdownLinks(site: { name: string, url: string }, path: string, appBase = "/"): DocsMarkdownLinks {
  const markdownPath = docsAppPath(docsRawPath(path), appBase)
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
