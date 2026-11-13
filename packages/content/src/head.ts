import { servedBlobUrl } from "@vite-hub/blob/served"
import { isRecordOrFunction as isRecord } from "@vite-hub/internal/object"

/** Where the site lives and what it is called. */
export interface ContentHeadSite {
  /** Public origin, such as `https://example.com`. Turns document URLs and image paths into absolute URLs. */
  url?: string
  /** Site name for `og:site_name` and the default title template, such as `ViteHub`. */
  name?: string
  /** Locale for `og:locale`, such as `en_US`. */
  locale?: string
}

/** Site-wide fallbacks, often read from a settings document. */
export interface ContentHeadDefaults {
  title?: string
  description?: string
  /** A URL, or a Blob reference that `resolveImage` turns into one. */
  image?: unknown
}

/**
 * What `contentHead()` reads from the collection of a document: a Content collection, such as
 * `content.collection('posts')`, or its JSON form with `schema`.
 */
export interface ContentHeadCollection {
  /** The name of the `seo()` field, as a Content collection reports it. */
  seo?: string
  /** The string field that names a document, such as `title`. */
  titleField?: string
  /** JSON Schema of the fields. The `seo()` field carries the `x-vitehub-seo` keyword. */
  schema?: Record<string, unknown>
}

export interface ContentHeadOptions {
  site?: ContentHeadSite
  defaults?: ContentHeadDefaults
  /**
   * The collection of the document, such as `content.collection('posts')`. `contentHead()` finds its `seo()` field by
   * the field's marker, whatever its name, and uses its `titleField` for the title.
   */
  collection?: ContentHeadCollection
  /**
   * Wraps the page title, such as `'%s · ViteHub'`, or a function. Defaults to `'%s · <site.name>'` when the site has a
   * name. The site's own title is not wrapped.
   */
  titleTemplate?: string | ((title: string) => string) | null
  /** The document field that holds `seo()` values. Defaults to the `seo()` field of `collection`, then to `seo`. */
  field?: string
  /**
   * Turn an image value into a URL. Defaults to strings as they are, and a Blob reference `{ pathname }` of the
   * `default` Blob Store to the URL that `blob.serve` serves it at. The served route comes from the generated Blob config,
   * so the default works on the server; in the browser, a Blob reference has no URL unless you pass this.
   */
  resolveImage?: (image: unknown) => string | null | undefined
  /** `og:type`. Defaults to `article` for a document with a URL and `website` otherwise. */
  type?: string
  /** Add JSON-LD for the page: `true` for a generated WebPage or Article, or your own object. */
  jsonLd?: boolean | Record<string, unknown>
  /**
   * Link the RSS feed of `defineContent({ seo: { rss } })` with `<link rel="alternate" type="application/rss+xml">`.
   * `href` defaults to `/rss.xml`, `title` to the site name.
   */
  rss?: boolean | { href?: string, title?: string }
}

export interface ContentHeadMeta {
  name?: string
  property?: string
  content: string
}

export interface ContentHeadLink {
  rel: string
  href: string
  /** The locale of an `alternate` link, or `x-default` for the page to show when no locale matches. */
  hreflang?: string
  /** The media type of an `alternate` link, such as `application/rss+xml`. */
  type?: string
  title?: string
}

export interface ContentHeadScript {
  type: "application/ld+json"
  /** Serialized JSON with `<` escaped, safe inside a script element. */
  innerHTML: string
}

/** Head tags in the shape `useHead()` from unhead, Nuxt, and `@unhead/vue` accepts. */
export interface ContentHead {
  title?: string
  meta: ContentHeadMeta[]
  link: ContentHeadLink[]
  script?: ContentHeadScript[]
  /** `<html lang>`: the locale of the version the page shows, in a collection with `locales`. */
  htmlAttrs?: { lang: string }
}

/** What `contentHead()` reads from a document: a Content read, an `/api/content` response, or any object with `data`. */
export interface ContentHeadDocument {
  data?: Record<string, unknown> | null
  /** Public URL path, such as `/blog/hello`, from the collection's `url`. */
  url?: string | null
  updatedAt?: string | null
  /** The locale of the version, in a collection with `locales`. With `fallback`, it is the source locale. */
  locale?: string | null
  /** Set when the page shows the source locale version because its own locale has no translation. */
  fallback?: boolean | null
  /** The page of the document in each locale that has its own version, source locale first, from `get()`. */
  alternates?: ReadonlyArray<{ locale: string, url: string }> | null
}

const descriptionFields = ["description", "summary", "excerpt"]
const titleFields = ["title", "name", "label", "heading"]

function text(value: unknown): string | undefined {
  return String(value) === value && value.trim() ? value.trim() : undefined
}

function firstText(data: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = text(data[field])
    if (value) return value
  }
}

/**
 * The string itself, or the URL that `blob.serve` serves a `{ pathname }` reference at, from the generated Blob config.
 * Undefined when the `default` Blob Store is not served, or where the Blob config is not loaded, such as in the browser.
 */
export function defaultContentImageUrl(image: unknown): string | undefined {
  if (text(image)) return text(image)
  if (!isRecord(image) || !text(image.pathname)) return
  return servedBlobUrl(String(image.pathname))
}

/** The `seo()` field of a collection: its reported name, or the property whose JSON Schema has `x-vitehub-seo`. */
function seoFieldOf(collection: ContentHeadCollection | undefined): string | undefined {
  if (text(collection?.seo)) return collection!.seo
  const properties = isRecord(collection?.schema) && isRecord(collection.schema.properties) ? collection.schema.properties : {}
  return Object.keys(properties).find(name => isRecord(properties[name]) && isRecord(properties[name]["x-vitehub-seo"]))
}

function absolute(url: string | undefined, site: string | undefined): string | undefined {
  if (!url) return
  if (/^https?:\/\//i.test(url) || !site) return url
  try {
    return new URL(url, site.endsWith("/") ? site : `${site}/`).href
  }
  catch {
    return url
  }
}

function jsonLdScript(value: Record<string, unknown>): ContentHeadScript {
  return { type: "application/ld+json", innerHTML: JSON.stringify(value).replace(/</g, "\\u003c") }
}

/**
 * Head tags for a Content document: title, description, canonical link, robots, Open Graph, and Twitter card tags, and
 * optional JSON-LD. A document with a `locale` sets `<html lang>`, and one with `alternates` in two or more locales gets
 * an `hreflang` link for each and `x-default` for the source locale. A fallback page is canonical to the source page. Per-document `seo()` values win, then the document's own title and description or summary fields,
 * then `defaults`. The result has the shape unhead's `useHead()` takes and depends on no framework.
 *
 * @example
 * useHead(contentHead(post, { site: { url: 'https://vitehub.dev', name: 'ViteHub' }, defaults: settings.data }))
 */
export function contentHead(document: ContentHeadDocument | null | undefined, options: ContentHeadOptions = {}): ContentHead {
  const data = isRecord(document?.data) ? document.data : {}
  const seoValue = data[options.field ?? seoFieldOf(options.collection) ?? "seo"]
  const seo = isRecord(seoValue) ? seoValue : {}
  const site = options.site ?? {}
  const defaults = options.defaults ?? {}
  const resolveImage = options.resolveImage ?? defaultContentImageUrl

  const titleField = text(options.collection?.titleField)
  const pageTitle = text(seo.title) ?? firstText(data, titleField ? [titleField, ...titleFields] : titleFields)
  const description = text(seo.description) ?? firstText(data, descriptionFields) ?? text(defaults.description)
  const imageValue = seo.image ?? defaults.image
  const image = absolute(imageValue === undefined || imageValue === null ? undefined : resolveImage(imageValue) ?? undefined, site.url)
  const path = text(document?.url)
  const locale = text(document?.locale)
  const alternates = Array.isArray(document?.alternates) ? document.alternates.filter(page => text(page?.locale) && text(page?.url)) : []
  // A fallback page shows the source locale version, so the source locale page is the canonical one.
  const source = document?.fallback === true ? alternates.find(page => page.locale === locale)?.url : undefined
  const canonical = absolute(text(seo.canonical) ?? source ?? path, site.url)
  const siteName = text(site.name)

  const template = options.titleTemplate === undefined ? (siteName ? `%s · ${siteName}` : null) : options.titleTemplate
  let title = pageTitle ?? text(defaults.title) ?? siteName
  if (pageTitle && template && pageTitle !== siteName) title = template instanceof Function ? template(pageTitle) : template.replace(/%s/g, pageTitle)

  const meta: ContentHeadMeta[] = []
  const add = (key: "name" | "property", name: string, content: string | undefined) => {
    if (content) meta.push(key === "name" ? { name, content } : { property: name, content })
  }
  add("name", "description", description)
  if (seo.noindex === true) add("name", "robots", "noindex")
  add("property", "og:title", pageTitle ?? title)
  add("property", "og:description", description)
  add("property", "og:type", options.type ?? (path ? "article" : "website"))
  add("property", "og:url", canonical)
  add("property", "og:image", image)
  add("property", "og:site_name", siteName)
  add("property", "og:locale", text(site.locale))
  add("name", "twitter:card", image ? "summary_large_image" : "summary")
  add("name", "twitter:title", pageTitle ?? title)
  add("name", "twitter:description", description)
  add("name", "twitter:image", image)

  const head: ContentHead = { meta, link: canonical ? [{ rel: "canonical", href: canonical }] : [] }
  if (alternates.length > 1) {
    for (const page of alternates) head.link.push({ rel: "alternate", hreflang: page.locale, href: absolute(page.url, site.url)! })
    head.link.push({ rel: "alternate", hreflang: "x-default", href: absolute(alternates[0]!.url, site.url)! })
  }
  if (options.rss) {
    const rss = options.rss === true ? {} : options.rss
    const feedTitle = text(rss.title) ?? siteName
    head.link.push({ rel: "alternate", type: "application/rss+xml", href: absolute(text(rss.href) ?? "/rss.xml", site.url)!, ...(feedTitle ? { title: feedTitle } : {}) })
  }
  if (locale) head.htmlAttrs = { lang: locale }
  if (title) head.title = title
  if (options.jsonLd) {
    const generated: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": path ? "Article" : "WebPage",
    }
    if (pageTitle ?? title) generated[path ? "headline" : "name"] = pageTitle ?? title
    if (description) generated.description = description
    if (canonical) generated.url = canonical
    if (image) generated.image = image
    if (text(document?.updatedAt)) generated.dateModified = document!.updatedAt
    head.script = [jsonLdScript(isRecord(options.jsonLd) ? options.jsonLd : generated)]
  }
  return head
}
