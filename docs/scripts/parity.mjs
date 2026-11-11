#!/usr/bin/env node
// Parity crawler for the docs site. It records every URL that the site serves to people and to agents, so a change
// to how the site loads content can show that no page changed.
//
//   node docs/scripts/parity.mjs crawl <base-url> <out-dir> [--site https://vitehub.dev] [--concurrency 8]
//   node docs/scripts/parity.mjs compare <before-dir> <after-dir> [--lines 12]
//
// `crawl` writes `<out-dir>/snapshot.json` (status, content type, redirect target, and hash per URL) and
// `<out-dir>/bodies/<hash>.txt` (the normalized body that the hash covers). `compare` prints added, removed, and
// changed entries, and exits with 1 when there is a difference or either crawl is incomplete.

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: "string" },
    concurrency: { type: "string", default: "8" },
    lines: { type: "string", default: "12" },
    limit: { type: "string", default: "20000" },
  },
})

// Crawl

/** Files that the site serves as they are built. They are not content, and their names change with each build. */
const ASSET_PATH = /^\/(?:_nuxt|_ipx|_docs|_fonts|og|__og-image__)\/|\.(?:png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|css|js|mjs|map|wasm|mp4|webm|zip|tgz|pdf)$/i
/** Requests that are not pages: they need a body, a session, or a query. */
const SKIP_PATH = /^\/(?:mcp|api\/(?!_docs\/))|^\/_vitehub\b/

async function crawl(baseInput, outDir) {
  const base = new URL(baseInput)
  const origin = base.origin
  let site = values.site ? new URL(values.site).origin : null
  const limit = Number(values.limit)
  const concurrency = Number(values.concurrency)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer")
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer")
  /** @type {Map<string, Entry>} */
  const entries = new Map()
  /** @type {Map<string, string>} */
  const bodies = new Map()
  const queued = new Set()
  const pages = new Set()
  /** @type {Array<{ key: string, run: () => Promise<void> }>} */
  const queue = []
  let truncated = false

  const accept = { html: "text/html,application/xhtml+xml", markdown: "text/markdown", any: "*/*" }

  /** Turn a link from any body into a site path, or null when it leaves the site. */
  function sitePath(link, from = "/") {
    let url
    try {
      url = new URL(link, new URL(from, origin))
    }
    catch {
      return null
    }
    if (url.origin !== origin && url.origin !== site) return null
    return url.pathname
  }

  function enqueue(key, run) {
    if (queued.has(key)) return
    if (queued.size >= limit) {
      truncated = true
      return
    }
    queued.add(key)
    queue.push({ key, run })
  }

  function enqueueGet(path, mode = "any") {
    if (!path || ASSET_PATH.test(path) || SKIP_PATH.test(path)) return
    const key = mode === "markdown" ? `GET ${path} [accept markdown]` : `GET ${path}`
    enqueue(key, () => fetchPath(key, path, accept[mode]))
  }

  /** A docs page: its HTML and every agent copy of it. */
  function enqueuePage(path) {
    path = path.length > 1 ? path.replace(/\/+$/, "") : path
    if (pages.has(path) || ASSET_PATH.test(path) || SKIP_PATH.test(path)) return
    pages.add(path)
    enqueueGet(path, "html")
    enqueueGet(path, "markdown")
    enqueueGet(path === "/" ? "/index.md" : `${path}.md`)
    enqueueGet(path === "/" ? "/raw/index.md" : `/raw${path}.md`)
    enqueueGet(`/api/_docs/page${path === "/" ? "/index" : path}.json`)
    const key = `MCP get-page ${path}`
    enqueue(key, () => mcpTool(key, "get-page", { path }))
  }

  async function fetchPath(key, path, acceptHeader) {
    const response = await request(new URL(path, origin), { headers: { accept: acceptHeader }, redirect: "manual" })
    const type = response.headers.get("content-type") ?? ""
    const location = response.headers.get("location")
    const raw = Buffer.from(await response.arrayBuffer())
    const text = raw.toString("utf8")
    if (path === "/sitemap.xml" && !site) site = sitemapOrigin(text)
    const body = normalize(text, type, path)
    record(key, { status: response.status, type, ...location ? { location: normalizeText(location) } : {} }, body)
    if (location) {
      const target = sitePath(location)
      if (target) enqueueGet(target, key.endsWith("[accept markdown]") ? "markdown" : acceptHeader === accept.html ? "html" : "any")
    }
    if (response.status >= 400) return
    discover(path, type, text)
  }

  /** Find more URLs in a body. Each format links in its own way. */
  function discover(path, type, text) {
    if (type.includes("xml")) {
      for (const [, loc] of text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
        const target = sitePath(decodeEntities(loc))
        if (!target) continue
        if (target.endsWith(".xml")) enqueueGet(target)
        else enqueuePage(target)
      }
      return
    }
    if (type.includes("html")) {
      for (const [, href] of text.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) {
        const target = sitePath(decodeEntities(href), path)
        if (target) enqueueGet(target, "html")
      }
      return
    }
    if (type.includes("json")) {
      let data
      try {
        data = JSON.parse(text)
      }
      catch {
        return
      }
      if (path === "/api/_docs/search.json" && Array.isArray(data)) {
        for (const item of data) if (typeof item?.id === "string") enqueuePage(item.id.split("#")[0] || "/")
      }
      else if (path === "/.well-known/skills/index.json" && Array.isArray(data?.skills)) {
        for (const skill of data.skills) for (const file of skill.files ?? []) enqueueGet(`/.well-known/skills/${skill.name}/${file}`)
      }
      else if (path === "/openapi.json" && data?.paths) {
        for (const [route, operations] of Object.entries(data.paths)) if (!route.includes("{") && operations?.get) enqueueGet(route)
      }
      walkStrings(data, (value) => {
        if (/^https?:\/\//.test(value)) enqueueGet(sitePath(value))
      })
      return
    }
    // Markdown and plain text: llms.txt, llms-full.txt, sitemap.md, robots.txt, raw pages.
    for (const [, link, bare] of text.matchAll(/\]\(([^)\s]+)\)|(?:^|\s)(https?:\/\/[^\s)>"'`]+)/gm)) {
      // A relative link resolves against the file that holds it; a bare URL loses the punctuation that ends its sentence.
      const target = sitePath(link ?? bare.replace(/[.,;:!?]+$/, ""), path)
      if (!target) continue
      const page = /^\/raw(\/.*)\.md$/.exec(target)
      if (page) enqueuePage(page[1] === "/index" ? "/" : page[1])
      else if (/\.(?:md|txt|json|xml)$/.test(target)) enqueueGet(target)
      else enqueueGet(target, "html")
    }
    for (const [, sitemap] of text.matchAll(/^Sitemap:\s*(\S+)/gim)) enqueueGet(sitePath(sitemap))
  }

  let mcpSession = null
  async function mcp(method, params, id) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" }
    if (mcpSession) headers["mcp-session-id"] = mcpSession
    const response = await request(new URL("/mcp", origin), { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
    mcpSession = response.headers.get("mcp-session-id") ?? mcpSession
    const text = await response.text()
    const messages = response.headers.get("content-type")?.includes("event-stream")
      ? text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
      : text ? [JSON.parse(text)] : []
    return { status: response.status, message: messages.find(message => message.id === id) ?? null }
  }

  let mcpId = 1
  async function mcpTool(key, name, args) {
    const { status, message } = await mcp("tools/call", { name, arguments: args }, ++mcpId)
    const result = message?.result
    const content = (result?.content ?? []).map(part => part.type === "text" ? part.text : JSON.stringify(part)).join("\n")
    let body = content
    try {
      body = stableJson(JSON.parse(content))
    }
    catch {}
    record(key, { status, type: result?.isError ? "mcp/error" : message?.error ? `mcp/error ${message.error.code}` : "mcp/result" }, normalizeText(body))
    return content
  }

  function record(key, meta, body) {
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16)
    bodies.set(hash, body)
    entries.set(key, { ...meta, hash, bytes: Buffer.byteLength(body) })
  }

  let done = 0
  let failures = 0
  async function runJob(job, attempt = 0) {
    try {
      await job.run()
    }
    catch (error) {
      // A busy local server can drop a connection or answer with a plain error text. Try again before recording it.
      if (attempt < 2) return runJob(job, attempt + 1)
      failures++
      record(job.key, { status: 0, type: "fetch/error" }, String(error?.cause?.code ?? error?.message ?? error))
    }
    if (++done % 250 === 0) console.error(`  ${done} done, ${queue.length} queued`)
  }

  /** Run queued jobs, a few at a time, until none is left. A job can queue more jobs. */
  async function drain() {
    const running = new Set()
    while (queue.length || running.size) {
      while (queue.length && running.size < concurrency) {
        const promise = runJob(queue.shift()).finally(() => running.delete(promise))
        running.add(promise)
      }
      await Promise.race(running)
    }
  }

  const started = Date.now()
  // The sitemap first, so the site origin is known before other bodies link to it.
  enqueueGet("/sitemap.xml")
  await drain()
  for (const path of ["/", "/robots.txt", "/sitemap.md", "/llms.txt", "/llms-full.txt", "/api/_docs/search.json", "/openapi.json", "/.well-known/api-catalog", "/.well-known/mcp/server-card.json", "/.well-known/skills/index.json"]) enqueueGet(path)
  enqueuePage("/")
  // A missing page answers with a 404 body for people and one for agents.
  enqueueGet("/__parity__/missing-page", "html")
  enqueueGet("/__parity__/missing-page", "markdown")

  // The MCP server lists its pages; list-pages is a source of pages too.
  let initialized = false
  await runJob({ key: "MCP initialize", run: async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitehub-docs-parity", version: "1" } }, 1)
    if (!init?.message?.result) {
      failures++
      record("MCP initialize", { status: init?.status ?? 0, type: "mcp/unavailable" }, "")
      return
    }
    await mcp("notifications/initialized", undefined, undefined)
    initialized = true
  } })
  if (initialized) {
    await runJob({ key: "MCP list-pages", run: async () => {
      const list = await mcpTool("MCP list-pages", "list-pages", {})
      try {
        for (const page of JSON.parse(list)) if (typeof page?.path === "string") enqueuePage(page.path)
      }
      catch {}
    } })
  }
  await drain()

  await mkdir(join(outDir, "bodies"), { recursive: true })
  const sorted = Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const complete = failures === 0 && !truncated
  const snapshot = { version: 2, site: site ?? origin, pages: pages.size, complete, failures, truncated, entries: sorted }
  await writeFile(join(outDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 1)}\n`)
  await Promise.all([...bodies].map(([hash, body]) => writeFile(join(outDir, "bodies", `${hash}.txt`), body)))

  const counts = {}
  for (const key of entries.keys()) {
    const kind = key.startsWith("MCP") ? "mcp" : key.endsWith("[accept markdown]") ? "accept markdown" : key.startsWith("GET /raw/") ? "raw" : key.startsWith("GET /api/_docs/page/") ? "page json" : key.endsWith(".md") ? "md" : "other"
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  const statuses = {}
  for (const entry of entries.values()) statuses[entry.status] = (statuses[entry.status] ?? 0) + 1
  console.log(`Crawled ${origin} in ${((Date.now() - started) / 1000).toFixed(1)}s: ${entries.size} entries, ${pages.size} pages, ${failures} fetch errors.`)
  console.log(`By kind: ${Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(", ")}`)
  console.log(`By status: ${Object.entries(statuses).map(([status, count]) => `${status} ${count}`).join(", ")}`)
  console.log(`Wrote ${join(outDir, "snapshot.json")}`)
  if (!complete) console.error(`Incomplete crawl: ${failures} failed requests${truncated ? `; request limit (${limit}) reached, URLs were skipped` : ""}. Snapshot is diagnostic only; retry the crawl${truncated ? " with a higher --limit" : ""}.`)
  return complete ? 0 : 1

  // Normalization. Keep what a reader or an agent gets; drop what changes with each build.

  function normalize(text, type, path) {
    if (type.includes("html")) return normalizeHtml(text)
    if (type.includes("json") || path.endsWith(".json")) {
      try {
        return normalizeText(stableJson(JSON.parse(text)))
      }
      catch {}
    }
    return normalizeText(text)
  }

  function normalizeText(text) {
    let out = text.split(origin).join("{origin}")
    if (site && site !== origin) out = out.split(site).join("{origin}")
    return out
      // Build assets have a content hash in their name.
      .replace(/\/_nuxt\/[^\s"'`)<>\\]+/g, "/_nuxt/{asset}")
      .replace(/\/_fonts\/[^\s"'`)<>\\]+/g, "/_fonts/{asset}")
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g, "{time}")
  }

  function normalizeHtml(html) {
    html = html.replace(/<!--[\s\S]*?-->/g, "")
    const lines = []
    const htmlTag = /<html\b([^>]*)>/i.exec(html)?.[1] ?? ""
    lines.push(`html ${attrs(htmlTag, ["lang", "dir"])}`)
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? ""
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
    if (title !== undefined) lines.push(`title ${text(title)}`)
    for (const [, meta] of head.matchAll(/<meta\b([^>]*)>/gi)) {
      const line = attrs(meta, ["charset", "name", "property", "http-equiv", "content"])
      if (line) lines.push(`meta ${line}`)
    }
    for (const [, link] of head.matchAll(/<link\b([^>]*)>/gi)) {
      const rel = attr(link, "rel") ?? ""
      if (/\b(?:modulepreload|preload|prefetch|stylesheet|dns-prefetch|preconnect)\b/.test(rel)) continue
      lines.push(`link ${attrs(link, ["rel", "href", "hreflang", "type", "title", "media", "sizes"])}`)
    }
    for (const [, json] of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        lines.push(`ld+json ${stableJson(JSON.parse(json))}`)
      }
      catch {
        lines.push(`ld+json ${json.trim()}`)
      }
    }
    let body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
    body = body
      .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    lines.push("--- headings")
    for (const [, level, tagAttrs, inner] of body.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)) {
      const id = attr(tagAttrs, "id")
      lines.push(`h${level}${id ? `#${id}` : ""} ${text(inner)}`)
    }
    lines.push("--- links")
    for (const [, tagAttrs] of body.matchAll(/<a\b([^>]*)>/gi)) {
      const href = attr(tagAttrs, "href")
      if (href !== undefined) lines.push(`a ${href}${attr(tagAttrs, "target") ? ` target=${attr(tagAttrs, "target")}` : ""}`)
    }
    for (const [, tagAttrs] of body.matchAll(/<img\b([^>]*)>/gi)) lines.push(`img ${attrs(tagAttrs, ["src", "alt"])}`)
    lines.push("--- text")
    const blocks = body
      .replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|pre|tr|td|th|table|section|article|aside|header|footer|nav|main|details|summary|blockquote|dl|dt|dd|figure|figcaption|button|label)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
    for (const line of decodeEntities(blocks).split("\n")) {
      const clean = line.replace(/\s+/g, " ").trim()
      if (clean) lines.push(clean)
    }
    return normalizeText(lines.join("\n"))
  }
}

/** @typedef {{ status: number, type: string, location?: string, hash: string, bytes: number }} Entry */

async function request(url, init, attempt = 0) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
    if ((response.status === 429 || response.status >= 502) && attempt < 3) {
      await response.arrayBuffer()
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt))
      return request(url, init, attempt + 1)
    }
    return response
  }
  catch (error) {
    if (attempt >= 3) throw error
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt))
    return request(url, init, attempt + 1)
  }
}

function sitemapOrigin(xml) {
  const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(xml)?.[1]
  try {
    return loc ? new URL(decodeEntities(loc)).origin : null
  }
  catch {
    return null
  }
}

function attr(source, name) {
  const match = new RegExp(`(?:^|\\s)${name}(?:=(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=\\s|/|$)`, "i").exec(source)
  if (!match) return undefined
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "")
}

function attrs(source, names) {
  return names.flatMap((name) => {
    const value = attr(source, name)
    return value === undefined ? [] : [`${name}=${JSON.stringify(value)}`]
  }).join(" ")
}

function text(html) {
  return decodeEntities(html.replace(/<svg\b[\s\S]*?<\/svg>/gi, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") return String.fromCodePoint(entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
    return named[entity.toLowerCase()] ?? match
  })
}

function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 1)
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
  return value
}

function walkStrings(value, visit) {
  if (typeof value === "string") visit(value)
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, visit)
  else if (value && typeof value === "object") for (const item of Object.values(value)) walkStrings(item, visit)
}

// Compare

async function compare(beforeDir, afterDir) {
  const before = JSON.parse(await readFile(join(beforeDir, "snapshot.json"), "utf8"))
  const after = JSON.parse(await readFile(join(afterDir, "snapshot.json"), "utf8"))
  let incomplete = false
  for (const [dir, snapshot] of [[beforeDir, before], [afterDir, after]]) {
    if (snapshot.complete !== true || snapshot.failures || snapshot.truncated || Object.values(snapshot.entries).some(entry => entry.status === 0)) {
      console.error(`Incomplete snapshot: ${dir}. Run crawl again successfully before comparing.`)
      incomplete = true
    }
  }
  if (incomplete) return 1
  const maxLines = Number(values.lines)
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])
  const added = []
  const removed = []
  const changed = []
  for (const key of [...keys].sort()) {
    const a = before.entries[key]
    const b = after.entries[key]
    if (!a) added.push(key)
    else if (!b) removed.push(key)
    else if (a.status !== b.status || a.type !== b.type || a.location !== b.location || a.hash !== b.hash) changed.push([key, a, b])
  }
  if (added.length) {
    console.log(`Added (${added.length}):`)
    for (const key of added) console.log(`  + ${key} ${after.entries[key].status}`)
  }
  if (removed.length) {
    console.log(`Removed (${removed.length}):`)
    for (const key of removed) console.log(`  - ${key} ${before.entries[key].status}`)
  }
  if (changed.length) {
    console.log(`Changed (${changed.length}):`)
    for (const [key, a, b] of changed) {
      console.log(`  ~ ${key}`)
      for (const field of ["status", "type", "location"]) if (a[field] !== b[field]) console.log(`      ${field}: ${a[field] ?? "(none)"} -> ${b[field] ?? "(none)"}`)
      if (a.hash !== b.hash) console.log(bodyDiff(await body(beforeDir, a.hash), await body(afterDir, b.hash), maxLines))
    }
  }
  const total = added.length + removed.length + changed.length
  console.log(`${keys.size} entries: ${added.length} added, ${removed.length} removed, ${changed.length} changed.`)
  return total ? 1 : 0
}

async function body(dir, hash) {
  const file = join(dir, "bodies", `${hash}.txt`)
  return existsSync(file) ? readFile(file, "utf8") : null
}

/** The changed middle of two bodies, after their shared first and last lines. */
function bodyDiff(a, b, maxLines) {
  if (a === null || b === null) return "      (body not stored)"
  const left = a.split("\n")
  const right = b.split("\n")
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let end = 0
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++
  const minus = left.slice(start, left.length - end)
  const plus = right.slice(start, right.length - end)
  const clip = line => line.length > 200 ? `${line.slice(0, 200)}...` : line
  const out = [`      @@ line ${start + 1}: -${minus.length} +${plus.length}`]
  for (const line of minus.slice(0, maxLines)) out.push(`      - ${clip(line)}`)
  if (minus.length > maxLines) out.push(`      - ... ${minus.length - maxLines} more`)
  for (const line of plus.slice(0, maxLines)) out.push(`      + ${clip(line)}`)
  if (plus.length > maxLines) out.push(`      + ... ${plus.length - maxLines} more`)
  return out.join("\n")
}

const [command, first, second] = positionals
if (command === "crawl" && first && second) process.exitCode = await crawl(first, second)
else if (command === "compare" && first && second) process.exitCode = await compare(first, second)
else {
  console.error("Usage:\n  parity.mjs crawl <base-url> <out-dir> [--site <origin>] [--concurrency <n>]\n  parity.mjs compare <before-dir> <after-dir> [--lines <n>]")
  process.exitCode = 2
}
