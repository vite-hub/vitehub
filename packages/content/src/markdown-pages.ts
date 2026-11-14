// The Markdown copy of an app page that is not a Content document: the HTML that the app renders, converted with mdream.
// The Markdown middleware loads this module on the first request that needs a converted copy.
import { htmlToMarkdown } from "@mdream/js"
import { filterPlugin, isolateMainPlugin } from "@mdream/js/plugins"

/** Elements that a reader does not see, or that are controls and not text. */
const excluded = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "nav",
  "aside",
  "footer",
  "form",
  "button",
  "dialog",
  "[hidden]",
  "[aria-hidden=\"true\"]",
]

function pageTitle(html: string): string | undefined {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  // The title element holds text only. Convert it to decode its character references.
  const text = title ? htmlToMarkdown(`<p>${title.replace(/</g, "&lt;")}</p>`).trim() : ""
  return text || undefined
}

/** The `content` of the `<meta name="robots">` tags of a page, such as `noindex`, or undefined without one. */
export function robotsMeta(html: string): string | undefined {
  const values: string[] = []
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']?robots["'\s/>]/i.test(tag)) continue
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
    const value = (content?.[1] ?? content?.[2])?.trim()
    if (value) values.push(value)
  }
  return values.length ? values.join(", ") : undefined
}

/**
 * Convert a rendered HTML page to Markdown: the content of `<main>`, or of the part that mdream finds as the main
 * content, without navigation, footers, controls, scripts, and hidden elements. Links and images become absolute URLs
 * of `origin`. When the content has no `# ` heading first, the page `<title>` is the heading.
 */
export function renderPageMarkdown(html: string, options: { origin: string }): string {
  const body = htmlToMarkdown(html, { origin: options.origin, plugins: [isolateMainPlugin(), filterPlugin({ exclude: excluded })] }).trim()
  const title = /^#\s/.test(body) ? undefined : pageTitle(html)
  return `${[title ? `# ${title}` : "", body].filter(Boolean).join("\n\n")}\n`
}
