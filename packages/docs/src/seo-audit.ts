import { ELEMENT_NODE, parse, walkSync } from "ultrahtml"

/**
 * The search checks that every prerendered page must pass. The limits are those of common site audits, such as OpenSEO:
 * a title of 10 to 60 characters, a description of 70 to 160, one `h1`, headings that go down one level at a time, and
 * at least 150 words of text.
 */
export const docsSeoLimits = {
  title: { min: 10, max: 60 },
  description: { min: 70, max: 160 },
  words: 150,
}

/** What the check reads from the HTML of one prerendered page. */
export interface DocsSeoPage {
  /** The app path, such as `/docs/kv`. */
  path: string
  title: string
  description: string
  /** The path of the canonical link, or `null` without one. A page whose canonical is another page is a copy. */
  canonical: string | null
  noindex: boolean
  /** A `<meta http-equiv="refresh">` page, which Nitro writes for a redirect. */
  redirect: boolean
  h1: number
  /** The first heading that skips a level, such as `h1 → h3`. */
  headingSkip: string | null
  words: number
  /** App paths of the links on the page, without query and fragment. */
  links: string[]
}

// Text in these elements is not visible. `pre` is visible, so code counts as words, as audits count it.
const hiddenElements = /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi
const blockTags = /<\/?(?:address|article|aside|blockquote|br|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p|pre|section|summary|table|td|th|tr|ul)\b[^>]*>/gi

/**
 * Reads one prerendered HTML page at an app path. `origin` is the site URL with the app base, such as
 * `https://acme.dev/help`, so links and the canonical link turn into app paths too.
 */
export function readDocsSeoPage(path: string, html: string, origin: string): DocsSeoPage {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? ""
  const body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html).replace(hiddenElements, " ")
  const meta = (name: string) => attribute(head.match(new RegExp(`<meta\\b[^>]*\\b(?:name|http-equiv)=["']${name}["'][^>]*>`, "i"))?.[0], "content")
  const canonical = attribute(head.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i)?.[0], "href")
  const levels: number[] = []
  walkSync(parse(body), (node, parent) => {
    if (node.type !== ELEMENT_NODE || !/^h[1-6]$/i.test(node.name)) return
    // A preview demonstrates its own document, including headings, without changing the page's outline.
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type === ELEMENT_NODE && ancestor.attributes.class?.split(/\s+/).includes("docs-example-preview")) return
    }
    levels.push(Number(node.name[1]))
  })
  const skip = levels.findIndex((level, index) => index > 0 && level > levels[index - 1]! + 1)
  const text = decode(body.replace(blockTags, " ").replace(/<[^>]+>/g, ""))
  const links = new Set<string>()
  for (const match of body.matchAll(/<a\b[^>]*>/gi)) {
    const link = appPath(attribute(match[0], "href"), path, origin)
    if (link) links.add(link)
  }
  return {
    path,
    title: decode(head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim(),
    description: (meta("description") ?? "").trim(),
    canonical: canonical === undefined ? null : appPath(canonical, path, origin) ?? canonical,
    noindex: /\bnoindex\b/i.test(meta("robots") ?? ""),
    redirect: meta("refresh") !== undefined,
    h1: levels.filter(level => level === 1).length,
    headingSkip: skip > 0 ? `h${levels[skip - 1]} → h${levels[skip]}` : null,
    words: text.split(/\s+/).filter(Boolean).length,
    links: [...links],
  }
}

/** The app paths of a sitemap. `origin` is the site URL with the app base, as for {@link readDocsSeoPage}. */
export function docsSitemapPaths(xml: string, origin: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(match => appPath(decode(match[1]!), "/", origin) ?? match[1]!)
}

/**
 * The problems of a site: each page in the sitemap must be a prerendered page and not a redirect, and each page that
 * search engines index needs its own title and description within the limits, one `h1`, headings in order, enough
 * text, and a link from another page. A page that is a copy, through `noindex` or a canonical link to another page,
 * is left out. Each problem is one sentence that names the fix.
 */
export function docsSeoProblems(pages: readonly DocsSeoPage[], sitemap: readonly string[]): string[] {
  const problems: string[] = []
  const byPath = new Map(pages.map(page => [page.path, page]))
  for (const path of sitemap) {
    const page = byPath.get(path)
    if (!page) problems.push(`${path} is in the sitemap, but the build did not prerender it as a page. Remove it from the sitemap, or make it a page.`)
    else if (page.redirect) problems.push(`${path} is in the sitemap, but it redirects. List the page that it redirects to instead.`)
  }

  const indexed = pages.filter(page => !page.redirect && !page.noindex && (page.canonical === null || page.canonical === page.path))
  const { title, description, words } = docsSeoLimits
  for (const page of indexed) {
    const at = page.path
    if (!page.title) problems.push(`${at} has no title. Set \`title\` in its frontmatter.`)
    else if (page.title.length < title.min || page.title.length > title.max) problems.push(`${at} has a title of ${page.title.length} characters, "${page.title}". Keep it between ${title.min} and ${title.max}, with \`seo.title\` when the heading must stay.`)
    if (!page.description) problems.push(`${at} has no description. Set \`description\` in its frontmatter.`)
    else if (page.description.length < description.min || page.description.length > description.max) problems.push(`${at} has a description of ${page.description.length} characters. Keep it between ${description.min} and ${description.max}.`)
    if (page.h1 !== 1) problems.push(`${at} has ${page.h1} h1 headings. Give it one.`)
    if (page.headingSkip) problems.push(`${at} skips a heading level, ${page.headingSkip}. Go down one level at a time.`)
    if (page.words < words) problems.push(`${at} has ${page.words} words. Write at least ${words}, or merge it into another page.`)
  }
  for (const [field, label] of [["title", "title"], ["description", "description"]] as const) {
    const groups = new Map<string, string[]>()
    for (const page of indexed) if (page[field]) groups.set(page[field], [...groups.get(page[field]) ?? [], page.path])
    for (const [value, paths] of groups) {
      if (paths.length > 1) problems.push(`${paths.join(", ")} share the ${label} "${value}". Give each page its own.`)
    }
  }

  const linked = new Set<string>()
  for (const page of pages) for (const link of page.links) if (link !== page.path) linked.add(link)
  for (const page of indexed) {
    if (page.path !== "/" && !linked.has(page.path)) problems.push(`No page links to ${page.path}. Link it from the navigation, the footer, or a related page.`)
  }
  return problems
}

/** Pages that search engines would flag. The build stops on them while the check is on. */
export class DocsSeoError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Docs pages fail the search checks:\n${problems.map(problem => `- ${problem}`).join("\n")}`)
    this.name = "DocsSeoError"
    this.problems = problems
  }
}

function attribute(tag: string | undefined, name: string): string | undefined {
  if (!tag) return undefined
  const value = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return value ? decode(value[1] ?? value[2] ?? value[3] ?? "") : undefined
}

/** The app path of a link, without the app base, or `null` for a link that leaves the site. */
function appPath(href: string | undefined, from: string, origin: string): string | null {
  if (!href || /^(?:[a-z][a-z\d+.-]*:(?!\/\/)|#)/i.test(href)) return null
  const site = new URL(origin || "http://docs.invalid")
  const base = site.pathname.replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(href, `${site.origin}${base}${from}`)
  }
  catch {
    return null
  }
  if (url.origin !== site.origin || (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`))) return null
  const path = url.pathname.slice(base.length) || "/"
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return entities[entity.toLowerCase()] ?? match
    const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return Number.isNaN(code) ? match : String.fromCodePoint(code)
  })
}
