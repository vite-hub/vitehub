/** Which pages get the overlay. Globs are relative to the app base: `*` is one path segment and `**` any depth. */
export interface CommentsOverlayOptions {
  /** Pages that get the overlay. Default: every page. */
  paths?: string[]
  /** Pages that never get it. */
  exclude?: string[]
  /**
   * When the loader asks the server whether the visitor may read comments. Default `"always"`: on page load and
   * navigation. `"marker"` also requires a readable `vitehub_session` cookie maintained by your app's auth lifecycle.
   */
  session?: "always" | "marker"
}

/**
 * The prebuilt loader and overlay. `vite-hub` supplies them. Both file names carry a hash of their content, so a page
 * names the exact versions it loads and an old page can never mix with a new bundle.
 */
export interface CommentsOverlayAssets {
  /** Directory with the two files. */
  dir: string
  /** File name of the loader, such as `loader.1a2b3c4d.js`. */
  loader: string
  /** File name of the overlay, such as `overlay.5e6f7a8b.js`. */
  overlay: string
}

/** Where the loader and overlay are served, below the app mount. */
export const overlayRoute = "/_vitehub/comments"

/** The path the app is mounted at: `""` for the root, `"/portal"` below it. A relative or empty Vite base is the root. */
export function mountPath(base: string | undefined): string {
  if (!base || base === "./") return ""
  let pathname = base
  if (/^https?:\/\//.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    }
    catch {
      return ""
    }
  }
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return ""
  return pathname.replace(/\/+$/, "")
}

/** The URL of the loader. Its query names the overlay file, says whether the app can edit pages, and carries the page filter and when to ask. */
export function loaderUrl(mount: string, assets: Pick<CommentsOverlayAssets, "loader" | "overlay">, options: CommentsOverlayOptions & { edit?: boolean } = {}): string {
  const filter = options.paths?.length || options.exclude?.length
    ? `&o=${encodeURIComponent(JSON.stringify({ exclude: options.exclude ?? [], paths: options.paths ?? [] }))}`
    : ""
  // `e=1`: the app has the Content cms preset, so the overlay may look for the document of a page (the Edit button).
  return `${mount}${overlayRoute}/${assets.loader}?f=${encodeURIComponent(assets.overlay)}${options.edit ? "&e=1" : ""}${options.session ? `&s=${options.session}` : ""}${filter}`
}

/** A nonce is base64 or base64url. Anything else is not put in a tag. */
const safeNonce = /^[\w+/=-]+$/

export function loaderTag(url: string, nonce?: string): string {
  const attribute = nonce && safeNonce.test(nonce) ? ` nonce="${nonce}"` : ""
  return `<script type="module"${attribute} src="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></script>`
}

/** The nonce that a `Content-Security-Policy` allows for scripts, when it has one. */
export function scriptNonce(policy: string | null | undefined): string | undefined {
  if (!policy) return undefined
  const directives = policy.split(";").map(directive => directive.trim().split(/\s+/))
  const scripts = directives.find(([name]) => name?.toLowerCase() === "script-src-elem")
    ?? directives.find(([name]) => name?.toLowerCase() === "script-src")
    ?? directives.find(([name]) => name?.toLowerCase() === "default-src")
  const nonce = scripts?.map(source => /^'nonce-([^']+)'$/.exec(source)?.[1]).find(Boolean)
  return nonce && safeNonce.test(nonce) ? nonce : undefined
}

/** Attribute values and their offsets in a complete tag, including unquoted values. Also serialized below. */
function htmlAttributes(tag: string) {
  const start = /^<\/?[a-z][\w:-]*/i.exec(tag)?.[0].length ?? tag.length
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  const attributes: { name: string, value: string, start: number, end: number }[] = []
  const source = tag.slice(start, -1)
  let match
  while ((match = pattern.exec(source))) {
    attributes.push({ name: match[1]!.toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? "", start: start + match.index, end: start + pattern.lastIndex })
  }
  return attributes
}

/** Self-contained apart from htmlAttributes, so both can be serialized into the generated middleware. */
function createHtmlScanner() {
  let raw = ""
  let comment = false
  let cdata = false
  let templates = 0
  return (html: string, start = 0): { scanned: number, close?: number, loaded?: { start: number, end: number } } => {
    let position = start
    while (position < html.length) {
      if (comment) {
        const end = html.indexOf("-->", position)
        if (end === -1) return { scanned: Math.max(position, html.length - 2) }
        comment = false
        position = end + 3
        continue
      }
      if (cdata) {
        const end = html.indexOf("]]>", position)
        if (end === -1) return { scanned: Math.max(position, html.length - 2) }
        cdata = false
        position = end + 3
        continue
      }
      if (raw === "plaintext") return { scanned: html.length }
      if (raw) {
        const end = new RegExp(`</${raw}(?=[\\s/>])`, "i").exec(html.slice(position))
        if (!end) return { scanned: Math.max(position, html.length - raw.length - 4) }
        position += end.index
      }
      else {
        const next = html.indexOf("<", position)
        if (next === -1) return { scanned: html.length }
        position = next
        if (html.startsWith("<!--", position)) {
          comment = true
          position += 4
          continue
        }
        // Foreign-content CDATA is text, even when it contains HTML-looking tags.
        if (html.startsWith("<![CDATA[", position)) {
          cdata = true
          position += 9
          continue
        }
      }
      const rest = html.slice(position)
      // Keep an incomplete tag for the next chunk; quoted attributes may contain closing-tag text.
      const tag = /^<(?:[^"'<>]|"[^"]*"|'[^']*')*>/.exec(rest)?.[0]
      if (!tag) {
        if (/^<(?:\/?[a-z!/?]|\/?$)/i.test(rest)) return { scanned: position }
        position++
        continue
      }
      const element = /^<(\/?)([a-z][\w:-]*)(?=[\s/>])/i.exec(tag)
      const name = element?.[2]?.toLowerCase()
      if (raw) raw = ""
      else if (name === "template") templates = element?.[1] === "/" ? Math.max(0, templates - 1) : templates + 1
      else if (!templates && element?.[1] === "/" && (name === "body" || name === "html")) return { close: position, scanned: position }
      else if (element?.[1] === "") {
        if (!templates && name === "script") {
          const src = htmlAttributes(tag).find(attribute => attribute.name === "src")?.value
          if (src && /\/_vitehub\/comments\/loader\.[\w-]+\.js(?:[?#]|$)/i.test(src)) return { loaded: { start: position, end: position + tag.length }, scanned: position }
        }
        if (name && /^(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/.test(name)) raw = name
      }
      position += tag.length
    }
    return { scanned: position }
  }
}

/** Puts the tag before the first `</body>` or `</html>`. A fragment, or a page that has the loader, stays as it is. */
export function injectLoader(html: string, tag: string, found = createHtmlScanner()(html)): string {
  const { close, loaded } = found
  if (loaded) {
    const nonce = htmlAttributes(tag).find(attribute => attribute.name === "nonce")?.value
    if (!nonce || !safeNonce.test(nonce)) return html
    const attributes = htmlAttributes(html.slice(loaded.start, loaded.end))
    const existing = attributes.find(attribute => attribute.name === "nonce")
    const at = loaded.start + (existing ?? attributes.find(attribute => attribute.name === "src"))!.start
    const end = existing ? loaded.start + existing.end : at
    return html.slice(0, at) + `nonce="${nonce}"${existing ? "" : " "}` + html.slice(end)
  }
  return close === undefined ? html : `${html.slice(0, close)}${tag}${html.slice(close)}`
}

/**
 * Source of the Nitro middleware that adds the loader to HTML responses: server-rendered pages and, when Nitro
 * prerenders them, the saved files. It is Nitro 3 middleware `(event, next)`. Where the host calls it without `next`,
 * such as Nitro 2 under Nuxt, it does nothing, and the `render:html` hook of the runtime plugin does the work.
 *
 * It rewrites only what is safe to rewrite: UTF-8 `text/html` that is not compressed, with a `</body>` or `</html>`.
 * A stream is piped through a transform that holds back a short tail, so a tag split across chunks is still found.
 */
export function renderOverlayMiddleware(url: string): string {
  return [
    "// Generated by @vite-hub/comments. Do not edit.",
    `const url = ${JSON.stringify(url)}`,
    "const safeNonce = /^[\\w+/=-]+$/",
    `const htmlAttributes = ${htmlAttributes.toString()}`,
    `const createHtmlScanner = ${createHtmlScanner.toString()}`,
    `const inject = ${injectLoader.toString()}`,
    "// Keep a short tail plus any unfinished tag; the scanner carries raw-text and comment state across cuts.",
    "const tail = 4096",
    "",
    "function tagFor(nonce) {",
    "  const attribute = nonce && safeNonce.test(nonce) ? ` nonce=\"${nonce}\"` : \"\"",
    "  return `<script type=\"module\"${attribute} src=\"${url.replaceAll(\"&\", \"&amp;\").replaceAll('\"', \"&quot;\")}\"></script>`",
    "}",
    "",
    "function scriptNonce(policy) {",
    "  if (!policy) return undefined",
    "  const directives = policy.split(\";\").map(directive => directive.trim().split(/\\s+/))",
    "  const scripts = directives.find(([name]) => name?.toLowerCase() === \"script-src-elem\")",
    "    ?? directives.find(([name]) => name?.toLowerCase() === \"script-src\")",
    "    ?? directives.find(([name]) => name?.toLowerCase() === \"default-src\")",
    "  const nonce = scripts?.map(source => /^'nonce-([^']+)'$/.exec(source)?.[1]).find(Boolean)",
    "  return nonce && safeNonce.test(nonce) ? nonce : undefined",
    "}",
    "",
    "// Only UTF-8 HTML that nothing has compressed or tagged with another charset.",
    "function rewritable(headers) {",
    "  if (headers.has(\"content-range\")) return false",
    "  const type = headers.get(\"content-type\") ?? \"\"",
    "  if (!/^text\\/html\\s*(;|$)/i.test(type)) return false",
    "  const charset = /;\\s*charset\\s*=\\s*\"?([^\";\\s]+)/i.exec(type)?.[1]",
    "  if (charset && !/^utf-?8$/i.test(charset)) return false",
    "  const encoding = headers.get(\"content-encoding\")",
    "  return !encoding || encoding.toLowerCase() === \"identity\"",
    "}",
    "",
    "function injector(tag) {",
    "  const decoder = new TextDecoder()",
    "  const encoder = new TextEncoder()",
    "  let pending = \"\"",
    "  let done = false",
    "  let scanned = 0",
    "  const scan = createHtmlScanner()",
    "  return new TransformStream({",
    "    transform(chunk, controller) {",
    "      pending += decoder.decode(chunk, { stream: true })",
    "      const found = done ? { scanned: pending.length } : scan(pending, scanned)",
    "      scanned = found.scanned",
    "      if (done || found.loaded || found.close !== undefined) {",
    "        done = true",
    "        controller.enqueue(encoder.encode(inject(pending, tag, found)))",
    "        pending = \"\"",
    "        return",
    "      }",
    "      if (pending.length > tail) {",
    "        let cut = Math.min(scanned, pending.length - tail)",
    "        if (cut > 0 && /[\\uD800-\\uDBFF]/.test(pending[cut - 1])) cut--",
    "        controller.enqueue(encoder.encode(pending.slice(0, cut)))",
    "        pending = pending.slice(cut)",
    "        scanned -= cut",
    "      }",
    "    },",
    "    flush(controller) {",
    "      pending += decoder.decode()",
    "      if (pending) controller.enqueue(encoder.encode(pending))",
    "    },",
    "  })",
    "}",
    "",
    "export default async function injectCommentsLoader(event, next) {",
    "  if (typeof next !== \"function\") return",
    "  const result = await next()",
    "  try {",
    "    const path = new URL(event.req.url).pathname",
    "    if (event.req.method !== \"GET\" || /\\/_vitehub(\\/|$)/.test(path)) return result",
    "    if (result instanceof Response) {",
    "      if (!result.body || result.status < 200 || result.status === 204 || result.status === 205 || result.status === 206 || result.status === 304 || !rewritable(result.headers)) return result",
    "      const tag = tagFor(scriptNonce(result.headers.get(\"content-security-policy\")))",
    "      const headers = new Headers(result.headers)",
    "      // The body changes, so its length does too, and so does any validator of the old bytes.",
    "      headers.delete(\"content-length\")",
    "      headers.delete(\"etag\")",
    "      return new Response(result.body.pipeThrough(injector(tag)), { headers, status: result.status, statusText: result.statusText })",
    "    }",
    "    if (typeof result === \"string\") {",
    "      const headers = event.res.headers",
    "      const type = headers.get(\"content-type\")",
    "      // A string with no type is HTML only when it looks like a page. One with another type is never touched.",
    "      if (headers.has(\"content-range\") || event.res.status === 206 || (type && !rewritable(headers))) return result",
    "      const injected = inject(result, tagFor(scriptNonce(headers.get(\"content-security-policy\"))))",
    "      if (injected !== result) {",
    "        headers.delete(\"content-length\")",
    "        headers.delete(\"etag\")",
    "      }",
    "      return injected",
    "    }",
    "  }",
    "  catch {",
    "    // A page without the overlay is better than a failed page.",
    "  }",
    "  return result",
    "}",
    "",
  ].join("\n")
}
