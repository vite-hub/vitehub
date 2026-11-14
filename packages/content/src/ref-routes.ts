import { addCacheBypass } from "@vite-hub/internal/runtime/cache-bypass"

import { contentRefTokenParameter } from "./preview-parameters.ts"
import { parseContentRef } from "./source-refs.ts"

import type { ContentHandlerOptions } from "./read-gate.ts"
import type { ContentSourceAllowReason } from "./source-access.ts"
import type { ContentSourcePull, ContentSourceRefKind } from "./source-refs.ts"

/** The URL shape of a preview route: `/tree/<branch>/-/<path>`, `/blob/<sha>/<path>`, or `/pr/<number>/<path>`. */
export type ContentPreviewRouteKind = "tree" | "blob" | "pr"

/** A preview URL, read by `parseContentPreviewPath()`. */
export interface ContentPreviewPath {
  route: ContentPreviewRouteKind
  /** The ref for `content.sources.allow()`: a branch name, a full commit SHA in lower case, or `pr/<number>`. */
  ref: string
  /** The app path that the page has in production, such as `/docs/kv`. It stays percent-encoded as in the URL. */
  path: string
  /** The part of the URL before `path`, such as `/tree/feat/x/-` or `/pr/12`. Links in the preview start with it. */
  prefix: string
}

/** The preview that the current request reads, from `content.sources.current()`. */
export interface ContentSourcePreview {
  /** The Content source name, such as `docs`. */
  source: string
  /** The ref of the URL: a branch name, a full commit SHA, or `pr/<number>`. */
  ref: string
  kind: ContentSourceRefKind
  /** The full commit SHA that every read of the Source returns in this request. */
  sha: string
  /** The pull request, for a `/pr/<number>` URL. Null for other URLs. */
  pull: ContentSourcePull | null
  route: ContentPreviewRouteKind
  /** The part of the URL before the app path, such as `/pr/12`. Put it before an app path to stay in the preview. */
  prefix: string
  /** The app path of the page, such as `/docs/kv`. */
  path: string
  /** The production URL of the page, for a canonical link or a "View in production" link. */
  url: string
}

/** Options of `content.sources.previewLinks()`. */
export interface ContentPreviewLinksOptions {
  /** The public origin of the links, such as `https://docs.example.com`. Defaults to `seo.site`, else links are paths. */
  site?: string
  /** How many seconds a signed link works: one hour by default, 24 hours at most. */
  maxAge?: number
}

/** One page of a pull request preview. */
export interface ContentPreviewLink {
  /** The Source key of the file, such as `docs/kv.md`. */
  key: string
  /** The app path that the page has in production, such as `/docs/kv`. */
  path: string
  /** The preview URL, such as `https://docs.example.com/pr/12/docs/kv`, with `?vitehub-content-token=` when signed. */
  url: string
}

/**
 * How a reader opens the links of `content.sources.previewLinks()`. `published`, `pull`, and `label` are public, as
 * `content.sources.allow()` decides. `token`: the pull request is private, so each link carries a signed token.
 * `fork`, `closed`, and `unpublished`: the links answer 404 until the rule changes, such as with the `preview:enabled`
 * label on a fork pull request. Content never signs these.
 */
export type ContentPreviewLinkAccess = Exclude<ContentSourceAllowReason, "console"> | "fork" | "closed" | "unpublished"

/** The result of `content.sources.previewLinks()`. */
export interface ContentPreviewLinks {
  /** The Content source name, such as `docs`. */
  source: string
  /** The repository of the Source, such as `acme/docs`. */
  repo: string
  /** The head commit of the pull request that the links show. */
  sha: string
  pull: ContentSourcePull
  access: ContentPreviewLinkAccess
  /** When the signed links stop working. Null for links without a token. */
  expiresAt: Date | null
  /** The pages that the pull request adds or changes, by path. Files that are not pages of the Source are left out. */
  pages: ContentPreviewLink[]
}

/** The routes of `previews: true`. */
export interface ContentSourcePreviewRoutes {
  /** The preview that the current request reads, or null outside a preview URL. */
  current(): ContentSourcePreview | null
  /**
   * Serve a request at a preview URL. Other URLs, refs that `allow()` denies, and a runtime without `previews` go to
   * `next` unchanged, so a denied ref gets the same 404 as any missing page. An allowed ref runs `next` with the app path,
   * and every read of the Source in that request returns the commit of the ref. Unless a Console preview cookie or a
   * signed token opened the ref, the request first asks `authorize` with `action: "read"`, as `/api/content/**` does,
   * with the user that `options.user` returns.
   */
  route(request: Request, next: (request: Request) => Response | Promise<Response>, options?: ContentHandlerOptions): Promise<Response>
  /**
   * The `/pr/<number>/<path>` links of the pages that a pull request adds or changes, from its GitHub file list. A
   * private pull request, such as one that the CMS opens with `publish: "pr"`, gets links with a signed token from
   * `content.sources.sign()`. This is trusted server API: check Console access before you call it. Throws
   * `CONTENT_R0079` without `previews`, and `CONTENT_R0075` when GitHub has no such pull request.
   */
  previewLinks(pull: number, options?: ContentPreviewLinksOptions): Promise<ContentPreviewLinks>
}

function isRouteKind(value: string): value is ContentPreviewRouteKind {
  return value === "tree" || value === "blob" || value === "pr"
}
const fullSha = /^[0-9a-f]{40}$/i
const pullNumber = /^[1-9]\d{0,8}$/

/** Decode one part of a URL path. Null when it does not decode, or when it holds a `/`, a `\`, or a dot part. */
function decodePart(part: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(part)
  }
  catch {
    return null
  }
  if (/[/\\\0]/.test(decoded) || decoded === "." || decoded === "..") return null
  return decoded
}

/**
 * Read a preview URL path. `/tree/<branch>/-/<path>` opens a branch, whose name can contain `/`; the part `-` ends it.
 * `/tree/<branch>` alone opens the root page. `/blob/<sha>/<path>` opens a full 40-character commit SHA, and
 * `/pr/<number>/<path>` the head commit of a pull request. Returns null for any other path, and for a ref that
 * `content.sources.at()` does not accept, an encoded `/`, or a dot part, so the page path cannot leave the prefix.
 */
export function parseContentPreviewPath(pathname: string): ContentPreviewPath | null {
  if (!pathname.startsWith("/")) return null
  const parts = pathname.slice(1).split("/")
  const route = parts[0]!
  if (!isRouteKind(route) || parts.length < 2) return null
  const decoded: string[] = []
  for (const part of parts.slice(1)) {
    const value = decodePart(part)
    if (value === null) return null
    decoded.push(value)
  }
  let refParts: string[]
  let rest: string[]
  if (route === "tree") {
    const separator = decoded.indexOf("-")
    if (separator < 0) {
      // `/tree/feat/x/` is the root page of `feat/x`.
      refParts = decoded.at(-1) === "" ? decoded.slice(0, -1) : decoded
      rest = []
    }
    else {
      refParts = decoded.slice(0, separator)
      rest = parts.slice(separator + 2)
    }
  }
  else {
    refParts = decoded.slice(0, 1)
    rest = parts.slice(2)
  }
  const raw = refParts.join("/")
  let ref: string
  if (route === "blob") {
    if (!fullSha.test(raw)) return null
    ref = raw.toLowerCase()
  }
  else if (route === "pr") {
    if (!pullNumber.test(raw)) return null
    ref = `pr/${raw}`
  }
  else {
    try {
      const parsed = parseContentRef(raw)
      // A SHA has its `/blob` URL and a pull request its `/pr` URL, so each commit view has one URL shape.
      if (parsed.kind !== "branch") return null
      ref = parsed.ref
    }
    catch {
      return null
    }
  }
  const prefix = route === "tree" ? `/tree/${ref}/-` : route === "blob" ? `/blob/${ref}` : `/pr/${raw}`
  return { route, ref, path: `/${rest.join("/")}`, prefix }
}

/** Whether a URL path may be a preview URL. It reads no more than the first part, so other requests pay nothing. */
export function mayBeContentPreviewPath(pathname: string): boolean {
  return pathname.startsWith("/tree/") || pathname.startsWith("/blob/") || pathname.startsWith("/pr/")
}

/** Whether a link is a path on the same site, such as `/docs/kv` or `/docs/kv#install`, and not `//host` or a preview URL. */
function isInternalLink(href: string, prefix: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/\\")) return false
  return href !== prefix && !href.startsWith(`${prefix}/`) && !href.startsWith(`${prefix}?`) && !href.startsWith(`${prefix}#`)
}

/** `href` with `query`, such as a signed-link token, added before its fragment. */
function withQuery(href: string, query: string | undefined): string {
  if (!query) return href
  const hash = href.indexOf("#")
  const base = hash < 0 ? href : href.slice(0, hash)
  return `${base}${base.includes("?") ? "&" : "?"}${query}${hash < 0 ? "" : href.slice(hash)}`
}

/**
 * An internal link with the preview prefix, such as `/pr/12/docs/kv` for `/docs/kv`. `query` is added to it, such as
 * the signed-link token that opened a private ref, so a reader who follows the link keeps access to the same ref.
 */
export function previewLink(href: string, prefix: string, query?: string): string {
  return isInternalLink(href, prefix) ? withQuery(`${prefix}${href}`, query) : href
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * A copy of a value with the internal `href` of each Comark element under the preview prefix. A Comark element is
 * `[tag, attributes, ...children]`. The walk goes through objects and arrays, so it works on a document, a list of
 * documents, and the JSON of `/api/content`. Values without a change are the same objects.
 */
export function rewriteContentLinks<T>(value: T, prefix: string, query?: string): T {
  // SAFETY: rewrite() returns a value of the same shape, with only `href` strings changed.
  return rewrite(value, prefix, query, 0) as T
}

function rewrite(value: unknown, prefix: string, query: string | undefined, depth: number): unknown {
  // Comark trees are deep, but not this deep. A cycle or a hostile value stops here.
  if (depth > 512) return value
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item, index) => {
      let result = rewrite(item, prefix, query, depth + 1)
      if (index === 1 && typeof value[0] === "string" && isRecord(item) && typeof item.href === "string") {
        const href = previewLink(item.href, prefix, query)
        if (href !== item.href) result = { ...(isRecord(result) ? result : item), href }
      }
      if (result !== item) changed = true
      return result
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value
  // Dates, Maps, and class instances keep their identity.
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  let copy: Record<string, unknown> | undefined
  for (const [key, item] of Object.entries(value)) {
    const result = rewrite(item, prefix, query, depth + 1)
    if (result === item) continue
    copy ??= { ...value }
    copy[key] = result
  }
  return copy ?? value
}

/**
 * The query that keeps a signed link working on the links and redirects of its preview, such as
 * `vitehub-content-token=...`. Undefined unless the signed link opened the ref.
 */
export function previewLinkQuery(requestUrl: string, reason: ContentSourceAllowReason): string | undefined {
  if (reason !== "token") return
  const token = new URL(requestUrl).searchParams.get(contentRefTokenParameter)
  return token ? `${contentRefTokenParameter}=${encodeURIComponent(token)}` : undefined
}

/**
 * A request for `url` that keeps everything else of `request`: the host fields that Nitro and srvx put on it, such as
 * `runtime`, `context`, `ip`, and `waitUntil`, and the raw Node request. `new Request(url, request)` drops them.
 */
export function requestWithUrl(request: Request, url: string): Request {
  const shadow: Record<PropertyKey, unknown> = { url, _url: undefined }
  return new Proxy(request, {
    get(target, property) {
      if (Object.hasOwn(shadow, property)) return shadow[property]
      const value: unknown = Reflect.get(target, property, target)
      // Methods of Request such as `json()` and `clone()` need the real Request as `this`. A host field such as
      // `waitUntil` is an own property, which a Proxy must return as it is.
      return typeof value === "function" && property !== "constructor" && !Object.hasOwn(target, property) ? value.bind(target) : value
    },
    set(target, property, value) {
      if (property === "url" || property === "_url") {
        shadow[property] = value
        return true
      }
      return Reflect.set(target, property, value, target)
    },
    has(target, property) {
      return Object.hasOwn(shadow, property) || Reflect.has(target, property)
    },
  })
}

/** An application `Cache-Control` that keeps a response out of shared caches. Preview rules never loosen it. */
const privateCache = /(?:^|[\s,])(?:private|no-store|no-cache)(?:$|[\s,=])/i

/** The `Cache-Control` of a preview response. */
export function previewCacheControl(route: ContentPreviewRouteKind, reason: ContentSourceAllowReason): string {
  // A cookie or a signed link opened a ref that may be private. No shared cache keeps it.
  if (reason === "console" || reason === "token") return "private, no-store"
  // A commit in the published history stays public, and its content never changes.
  if (route === "blob" && reason === "published") return "public, max-age=31536000, immutable"
  // A branch or pull request moves, and a label or pull request state can change. `allow()` holds decisions as long.
  return "public, max-age=60"
}

function responseCacheControl(own: string | null, policy: string): string {
  if (policy === "private, no-store" || own === null) return policy
  const original = privateCache.test(own) && !/\b(?:private|no-store)\b/i.test(own) ? `private, ${own}` : own
  const limit = Number(/max-age=(\d+)/.exec(policy)![1])
  let maxAge = false
  // Keep application revalidation and extension directives, and cap both browser and shared-cache lifetimes.
  const bounded = original.replace(/(^|,)(\s*)(max-age|s-maxage)\s*=\s*"?(\d+)"?(?=\s*(?:,|$))/gi, (_match, separator: string, space: string, name: string, age: string) => {
    if (name.toLowerCase() === "max-age") maxAge = true
    return `${separator}${space}${name}=${Math.min(Number(age), limit)}`
  })
  // A published Source commit does not make an arbitrary application response immutable.
  return maxAge || /\b(?:no-store|no-cache)\b/i.test(bounded) ? bounded : `${bounded ? `${bounded}, ` : ""}max-age=${limit}`
}

/**
 * The response of a preview page: `X-Robots-Tag: noindex`, a canonical `Link` header to the production URL, the
 * `Cache-Control` of `previewCacheControl()`, and a same-site redirect kept under the prefix.
 */
export function previewResponse(response: Response, preview: ContentSourcePreview, reason: ContentSourceAllowReason, requestUrl: string, gated = false): Response {
  let result = response
  try {
    result.headers.set("x-robots-tag", "noindex")
  }
  catch {
    // A response from `fetch()` has immutable headers.
    result = new Response(response.body, response)
    result.headers.set("x-robots-tag", "noindex")
  }
  result.headers.append("link", `<${preview.url}>; rel="canonical"`)
  // An answer that `authorize` allowed depends on the user, like a cookie answer.
  const policy = gated || result.headers.has("set-cookie") ? "private, no-store" : previewCacheControl(preview.route, reason)
  result.headers.set("cache-control", responseCacheControl(result.headers.get("cache-control"), policy))
  const location = result.headers.get("location")
  if (location !== null && result.status >= 300 && result.status < 400) {
    const origin = new URL(requestUrl).origin
    const target = URL.canParse(location, requestUrl) ? new URL(location, requestUrl) : undefined
    if (target?.origin === origin && !mayBeContentPreviewPath(target.pathname)) {
      const query = target.searchParams.has(contentRefTokenParameter) ? undefined : previewLinkQuery(requestUrl, reason)
      result.headers.set("location", withQuery(`${preview.prefix}${target.pathname}${target.search}`, query) + target.hash)
    }
  }
  return result
}

/** The part of a Content runtime that the preview routes plugin needs. */
export interface ContentPreviewRoutesHost {
  sources: ContentSourcePreviewRoutes
}

/** Loads the Content runtime, such as `() => import("./server/content.ts").then(module => module.default)`. */
export type ContentPreviewRoutesHostLoader = () => Promise<ContentPreviewRoutesHost>

/**
 * A Nitro 3 plugin that serves the preview URLs of `defineContent({ previews: true })`: `/tree/<branch>/-/<path>`,
 * `/blob/<sha>/<path>`, and `/pr/<number>/<path>`. It wraps Nitro's fetch entry, so the page runs with its production
 * path through route rules, middleware, and every handler, and each read of the `github()` Source returns the commit of
 * the ref. Nitro's cache is bypassed during a preview request, so a cached page never mixes refs. Other requests pass
 * straight through, and the loader runs on the first preview URL only. `options.user` gives `authorize` the user of a
 * preview request. ViteHub generates it for `server/content.ts`.
 */
export function defineContentPreviewRoutesPlugin(content: ContentPreviewRoutesHost | ContentPreviewRoutesHostLoader, options: ContentHandlerOptions = {}): (nitroApp: unknown) => void {
  return (nitroApp) => {
    if (!isRecord(nitroApp) || !(nitroApp.fetch instanceof Function)) return
    let host: ContentPreviewRoutesHost | undefined = content instanceof Function ? undefined : content
    let loading: Promise<ContentPreviewRoutesHost> | undefined
    const load = (): ContentPreviewRoutesHost | Promise<ContentPreviewRoutesHost> => {
      if (host) return host
      if (!(content instanceof Function)) return content
      loading ??= content().then((loaded) => {
        host = loaded
        return loaded
      }, (error: unknown) => {
        loading = undefined
        throw error
      })
      return loading
    }
    const removeCacheBypass = addCacheBypass(() => host?.sources.current() != null)
    const hooks = nitroApp.hooks
    if (isRecord(hooks) && hooks.hook instanceof Function) {
      for (const name of ["close", "shutdown", "dispose"]) Reflect.apply(hooks.hook, hooks, [name, removeCacheBypass])
    }
    // Nitro's fetch entry calls `nitroApp.h3.fetch()` on each request. Wrapping that method, not `nitroApp.fetch`, also
    // reaches a server entry that took `nitroApp.fetch` before this plugin ran, as after an earlier async plugin.
    const h3 = nitroApp.h3
    const owner: Record<string, unknown> = isRecord(h3) && h3.fetch instanceof Function ? h3 : nitroApp
    const fetch = owner.fetch
    if (!(fetch instanceof Function)) return
    owner.fetch = (request: unknown, ...rest: unknown[]) => {
      const call = (next: unknown) => Reflect.apply(fetch, owner, [next, ...rest])
      if (!(request instanceof Request)) return call(request)
      // Most requests are not preview URLs, so they skip parsing.
      const start = request.url.indexOf("/", request.url.indexOf("//") + 2)
      if (start < 0 || !mayBeContentPreviewPath(request.url.slice(start))) return call(request)
      return (async () => {
        const loaded = await load()
        return await loaded.sources.route(request, async (next) => {
          const response: unknown = await call(next)
          if (response instanceof Response) return response
          // Internal invariant: the fetch entry of Nitro 3 always resolves to a Response.
          throw new TypeError("[vitehub] Nitro's fetch entry did not return a Response.")
        }, options)
      })()
    }
  }
}
