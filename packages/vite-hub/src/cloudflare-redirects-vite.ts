import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { reportViteHubHint } from "@vite-hub/internal/hints"
import { formatDiagnostic } from "nostics"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

import type { Plugin, ResolvedConfig } from "vite"

/** A `redirect` route rule after Nitro normalizes it: `false` turns off a redirect of a less specific rule. */
type RedirectRule = false | { to: string, status: number }

interface RedirectRoute {
  route: string
  redirect: RedirectRule
}

/** A route rule that the `_redirects` file cannot hold. The server still redirects it. */
export interface SkippedRedirect {
  route: string
  reason: string
}

const statuses = new Set([301, 302, 303, 307, 308])
const methodKey = /^[A-Z]+\s+\//
const placeholder = /^:([A-Za-z]\w*)$/
const catchAll = /^\*\*(?::[A-Za-z]\w*)?$/
// Cloudflare's limits for one `_redirects` file of Workers static assets.
const maxStatic = 2000
const maxDynamic = 100
const maxLine = 1000
const moduleName = "vite-hub/cloudflare-redirects-file"

type Segment = { kind: "static", value: string } | { kind: "param", name?: string } | { kind: "catchAll" } | { kind: "other" }

function segments(path: string): Segment[] {
  return path.split("/").slice(1).map((value, index, all): Segment => {
    if (catchAll.test(value) && index === all.length - 1) return { kind: "catchAll" }
    const name = placeholder.exec(value)?.[1]
    if (name) return { kind: "param", name }
    if (value === "*") return { kind: "param" }
    return /[*:?+(){}]/.test(value) ? { kind: "other" } : { kind: "static", value }
  })
}

const rank = { static: 0, param: 1, other: 1, catchAll: 2 } as const

/** Sorts the most specific route first, the order in which Nitro picks a route rule. Cloudflare uses the first match. */
function compareRoutes(a: RedirectRoute, b: RedirectRoute): number {
  const left = segments(a.route.replace(methodKey, "/"))
  const right = segments(b.route.replace(methodKey, "/"))
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const l = left[index]
    const r = right[index]
    if (!l || !r) return l ? 1 : -1
    if (rank[l.kind] !== rank[r.kind]) return rank[l.kind] - rank[r.kind]
  }
  return Number(!methodKey.test(a.route)) - Number(!methodKey.test(b.route))
}

/** Whether one request path can match both route patterns. */
function overlaps(a: Segment[], b: Segment[]): boolean {
  for (let index = 0; ; index++) {
    const l = a[index]
    const r = b[index]
    if (l?.kind === "catchAll" || r?.kind === "catchAll") return true
    if (!l || !r) return !l && !r
    if (l.kind === "static" && r.kind === "static" && l.value !== r.value) return false
  }
}

/**
 * The `_redirects` sources of a route, or the reason why Cloudflare cannot match it like Nitro does. Nitro matches
 * `/old` and `/old/` for both `/old` and `/old/`, and `/blog` and `/blog/` for `/blog/**`, so these get lines of their
 * own: Cloudflare matches only the path as written, and its `/blog/*` needs the slash.
 */
function source(route: string, baseURL: string): { exact: string[], splat?: string, names: string[] } | { reason: string } {
  if (methodKey.test(route)) return { reason: "it matches one HTTP method, and `_redirects` matches every method" }
  const names: string[] = []
  const parts = segments(route).map((segment, index) => {
    if (segment.kind === "static") return segment.value
    if (segment.kind === "catchAll") return "*"
    if (segment.kind === "other") return undefined
    // A single-segment `*` gets a placeholder, which also matches one segment. A greedy splat would match more.
    const name = segment.name ?? `segment${index}`
    names.push(name)
    return `:${name}`
  })
  if (parts.includes(undefined)) return { reason: "Cloudflare cannot match its pattern" }
  const path = `${baseURL.replace(/\/+$/, "")}/${parts.join("/")}`
  if (!path.endsWith("/*")) {
    const bare = path.replace(/\/+$/, "")
    return { exact: bare ? [bare, `${bare}/`] : ["/"], names }
  }
  const prefix = path.slice(0, -2)
  return { exact: prefix ? [prefix, `${prefix}/`] : ["/"], splat: path, names }
}

/**
 * The `_redirects` targets of a rule: `exact` for the exact sources and `splat` for the splat source. Or the reason why
 * Cloudflare cannot build them like Nitro does.
 */
function target(to: string, splat: boolean, names: string[]): { exact: string, splat: string } | { reason: string } {
  // Cloudflare drops the query of the request when the target has one. Nitro adds it to the target's query.
  if (to.includes("?")) return { reason: "its target has a query, and Cloudflare would drop the query of the request" }
  if (to.includes("**") && !(splat && to.endsWith("/**") && to.indexOf("**") === to.length - 2)) {
    return { reason: "Cloudflare can put the rest of the path only at the end of the target, after a route that ends with `/**`" }
  }
  if ([...names, "splat"].some(name => new RegExp(`:${name}(?!\\w)`).test(to))) {
    return { reason: "its target holds a `:name` that Cloudflare would replace and Nitro keeps" }
  }
  // Nitro sends `/blog` and `/blog/` of `/blog/** -> /posts/**` to `/posts`.
  if (!to.endsWith("/**")) return { exact: to, splat: to }
  return { exact: to.slice(0, -3) || "/", splat: `${to.slice(0, -3)}/:splat` }
}

/**
 * The `_redirects` lines for the `redirect` route rules, most specific first. A rule that `_redirects` cannot express
 * is skipped, and so is each less specific rule that would match its paths first, because Cloudflare would then
 * redirect those paths to the wrong place. A `redirect: false` rule counts as skipped.
 *
 * Each source path gets one line. Cloudflare rejects a file with two rules for one path, and it would use only the
 * first one. So when two routes give the same path, such as `/old` and `/old/`, or `/blog` and `/blog/**` for `/blog`,
 * the line of the more specific route stays, as Nitro also prefers it.
 */
export function routeRuleRedirects(routeRules: Record<string, { redirect?: RedirectRule }>, baseURL: string): { lines: string[], skipped: SkippedRedirect[] } {
  const routes = Object.entries(routeRules)
    .filter(([, rules]) => rules.redirect !== undefined)
    .map(([route, rules]): RedirectRoute => ({ route, redirect: rules.redirect! }))
    .sort(compareRoutes)
  const lines: string[] = []
  const sources = new Set<string>()
  const skipped: Array<SkippedRedirect & { pattern: Segment[] }> = []
  for (const { route, redirect } of routes) {
    const pattern = segments(route.replace(methodKey, "/"))
    const skip = (reason: string) => skipped.push({ route, reason, pattern })
    if (redirect === false) {
      skip("it turns off a redirect, and `_redirects` cannot")
      continue
    }
    const shadowed = skipped.find(earlier => overlaps(earlier.pattern, pattern))
    if (shadowed) {
      skip(`Cloudflare would use it for paths of the skipped rule \`${shadowed.route}\``)
      continue
    }
    if (!statuses.has(redirect.status)) {
      skip(`Cloudflare redirects only with 301, 302, 303, 307, or 308, not ${redirect.status}`)
      continue
    }
    const from = source(route, baseURL)
    if ("reason" in from) {
      skip(from.reason)
      continue
    }
    const to = target(redirect.to, from.splat !== undefined, from.names)
    if ("reason" in to) {
      skip(to.reason)
      continue
    }
    if (to.splat.startsWith("/") && !to.splat.startsWith("//") && overlaps(pattern, segments(new URL(to.splat, "http://h").pathname.replace(/:splat$/, "**")))) {
      skip("its target matches its own route, so Cloudflare would redirect in a loop")
      continue
    }
    const ruleLines = [
      ...from.exact.map(path => [path, `${path} ${to.exact} ${redirect.status}`] as const),
      ...from.splat ? [[from.splat, `${from.splat} ${to.splat} ${redirect.status}`] as const] : [],
    ].filter(([path]) => !sources.has(path))
    if (ruleLines.some(([, line]) => line.length > maxLine)) {
      skip(`its line is longer than Cloudflare's limit of ${maxLine} characters`)
      continue
    }
    for (const [path, line] of ruleLines) {
      sources.add(path)
      lines.push(line)
    }
  }
  return { lines, skipped: skipped.map(({ route, reason }) => ({ route, reason })) }
}

const ruleLine = /^\s*([^\s#]\S*)\s+\S+/

/**
 * Adds the route-rule lines after the rules of the app's own `_redirects` file, so the app's rules match first.
 * Returns `undefined` when the file would pass Cloudflare's limits of 2,000 static and 100 dynamic redirects.
 */
export function addRedirectsToFile(contents: string, routeLines: string[]): string | undefined {
  // A path that the file already has a rule for, such as from the app or an earlier run on the same output, gets no
  // second rule: Cloudflare rejects the file, and would use the first rule anyway.
  const present = new Set(contents.split("\n").map(line => ruleLine.exec(line)?.[1]).filter(from => from !== undefined))
  const lines = routeLines.filter(line => !present.has(ruleLine.exec(line)?.[1] ?? ""))
  if (lines.length === 0) return contents
  const all = [...contents.split("\n"), ...lines].map(line => ruleLine.exec(line)?.[1]).filter(from => from !== undefined)
  const dynamic = all.filter(from => /[*:]/.test(from)).length
  if (dynamic > maxDynamic || all.length - dynamic > maxStatic) return
  return contents.trim() ? `${contents.trimEnd()}\n${lines.join("\n")}\n` : `${lines.join("\n")}\n`
}

interface NitroLike {
  logger: { warn(message: string): void }
  hooks: { hook(name: "compiled", callback: () => Promise<void>): unknown }
  options: {
    baseURL: string
    dev: boolean
    output: { publicDir: string }
    preset?: string
    routeRules: Record<string, { redirect?: RedirectRule }>
  }
}

/**
 * Cloudflare serves a static file, such as a prerendered page, before the Worker runs, so a `redirect` route rule
 * never reaches it. Nitro's `cloudflare-pages` preset writes these rules to `_redirects`, but its Workers presets do
 * not. This Nitro module adds them to the `_redirects` file of the static assets, after the preset moved the app's own
 * file there.
 */
export function cloudflareRedirectsFileNitroModule(report: (nitro: NitroLike, skipped: SkippedRedirect[] | "limit") => void): (nitro: NitroLike) => void {
  return (nitro: NitroLike) => {
    const preset = nitro.options.preset?.replaceAll("_", "-")
    if (nitro.options.dev || (preset !== "cloudflare-module" && preset !== "cloudflare-durable")) return
    nitro.hooks.hook("compiled", async () => {
      const { lines, skipped } = routeRuleRedirects(nitro.options.routeRules, nitro.options.baseURL)
      if (skipped.length > 0) report(nitro, skipped)
      if (lines.length === 0) return
      // The preset serves the static assets from the public directory without the base URL.
      const publicDir = nitro.options.output.publicDir.replace(/\/+$/, "")
      const base = nitro.options.baseURL.replace(/\/+$/, "")
      const file = join(base && publicDir.endsWith(base) ? publicDir.slice(0, -base.length) : publicDir, "_redirects")
      const contents = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      const next = addRedirectsToFile(contents, lines)
      if (next === undefined) return report(nitro, "limit")
      await writeFile(file, next, "utf8")
    })
  }
}

/**
 * Adds {@link cloudflareRedirectsFileNitroModule} to a Cloudflare build, and reports its skipped rules as hints. Nuxt
 * replays only the `config` hook of this plugin for its Nitro build, so there the Nitro logger prints the hint.
 */
export function cloudflareRedirectsFileVitePlugin(): Plugin {
  let resolved: ResolvedConfig | undefined
  const report = (nitro: NitroLike, skipped: SkippedRedirect[] | "limit") => {
    const diagnostic = skipped === "limit"
      ? viteHubErrorDiagnostics.VITE_HUB_REDIRECTS_FILE_TOO_LARGE({ dynamic: maxDynamic, static: maxStatic })
      : viteHubErrorDiagnostics.VITE_HUB_REDIRECTS_FILE_RULE_SKIPPED({ rules: skipped.map(({ route, reason }) => `\`${route}\`: ${reason}`).join("; ") })
    if (resolved) reportViteHubHint(resolved, diagnostic)
    else nitro.logger.warn(formatDiagnostic(diagnostic))
  }
  return {
    name: "vite-hub/cloudflare-redirects-file",
    config(config, env) {
      if (env.command !== "build") return
      // SAFETY: Nitro's Vite plugin reads its options from this documented top-level key.
      const viteConfig = config as typeof config & { nitro?: Record<string, unknown> }
      const nitro = viteConfig.nitro ??= {}
      const modules = Array.isArray(nitro.modules) ? nitro.modules : []
      if (modules.some(module => module && typeof module === "object" && Reflect.get(module, "name") === moduleName)) return
      nitro.modules = [...modules, { name: moduleName, setup: cloudflareRedirectsFileNitroModule(report) }]
    },
    configResolved(config) {
      resolved = config
    },
  }
}
