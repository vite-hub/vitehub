import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { hostFromNitroPreset } from "@vite-hub/internal/deployment"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

import type { SecurityPolicy } from "./_internal/runtime/security.ts"

/** The headers that `security: { headers: true }` adds. */
export const defaultSecurityHeaders = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
} as const

/**
 * Response headers for `security.headers`. A key is a header name. A string replaces the default value or adds a
 * header, such as `"X-Robots-Tag": "noindex"`. `false` removes a default header.
 */
export type SecurityHeaders = { [Name in keyof typeof defaultSecurityHeaders]?: string | false } & Record<string, string | false>

type ByteUnit = "b" | "kb" | "mb" | "gb" | "B" | "KB" | "MB" | "GB"

/** `security` options of `vitehub()`. */
export interface SecurityOptions {
  /**
   * Add safe response headers to every response that does not set them itself: `Strict-Transport-Security` (built
   * output only, not `vite dev`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
   * `X-Frame-Options: SAMEORIGIN`, and a `Permissions-Policy` that turns off the camera, geolocation, and microphone.
   * `true` uses this set. An object changes, adds, or removes (`false`) one header. Static files on Cloudflare,
   * Netlify, and Vercel get the same headers from the host's header config. Default: no headers.
   */
  headers?: boolean | SecurityHeaders
  /**
   * The largest request body, as bytes or a size such as `"1mb"` or `"500kb"` (1kb is 1024 bytes). A larger body gets
   * 413 with the code `VITE_HUB_REQUEST_BODY_TOO_LARGE`. It applies to every route. Default: no limit.
   */
  maxBodySize?: number | `${number}${ByteUnit}`
}

const byteUnits = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 } as const

/** Bytes from `security.maxBodySize`. Throws `VITE_HUB_SECURITY_MAX_BODY_SIZE_INVALID` for any other value. */
export function parseByteSize(value: unknown): number {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim()) : undefined
  const bytes = typeof value === "number"
    ? value
    : match ? Math.floor(Number(match[1]) * byteUnits[match[2]!.toLowerCase() as keyof typeof byteUnits]) : Number.NaN
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw viteHubErrorDiagnostics.VITE_HUB_SECURITY_MAX_BODY_SIZE_INVALID({ value: JSON.stringify(value) ?? String(value) })
  return bytes
}

/** The header list of `security.headers`, in the order of the defaults, then the added headers. */
export function resolveSecurityHeaders(headers: SecurityOptions["headers"]): SecurityPolicy["headers"] {
  if (!headers) return []
  const resolved = new Map<string, [string, string]>()
  for (const [name, value] of Object.entries(defaultSecurityHeaders)) resolved.set(name.toLowerCase(), [name, value])
  if (headers === true) return [...resolved.values()]
  for (const [name, value] of Object.entries(headers)) {
    if (value === false) {
      resolved.delete(name.toLowerCase())
      continue
    }
    try {
      new Headers([[name, value]])
    }
    catch {
      throw viteHubErrorDiagnostics.VITE_HUB_SECURITY_HEADER_INVALID({ name: JSON.stringify(name) })
    }
    resolved.set(name.toLowerCase(), [name, value])
  }
  return [...resolved.values()]
}

/** The resolved policy, or `undefined` when `security` adds nothing. */
export function resolveSecurityPolicy(options: SecurityOptions | undefined): SecurityPolicy | undefined {
  if (!options) return
  const headers = resolveSecurityHeaders(options.headers)
  const maxBodySize = options.maxBodySize === undefined ? undefined : parseByteSize(options.maxBodySize)
  if (headers.length === 0 && maxBodySize === undefined) return
  return { headers, ...(maxBodySize === undefined ? {} : { maxBodySize }) }
}

const headerLine = /^\s+(?:!\s*)?([^\s:]+)\s*:/gm

/**
 * Adds a `<base>*` rule with the headers to a Cloudflare or Netlify `_headers` file. Both hosts add the headers of
 * every rule that matches, and join two values of one header with a comma, so a header that the file already sets for
 * any path is left out.
 */
export function addSecurityHeadersToHeadersFile(contents: string, headers: SecurityPolicy["headers"], baseURL: string): string {
  const present = new Set([...contents.matchAll(headerLine)].map(match => match[1]!.toLowerCase()))
  const missing = headers.filter(([name]) => !present.has(name.toLowerCase()))
  if (missing.length === 0) return contents
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`
  const rule = [`${base}*`, ...missing.map(([name, value]) => `  ${name}: ${value}`)].join("\n")
  return contents.trim() ? `${contents.trimEnd()}\n${rule}\n` : `${rule}\n`
}

interface VercelRoute {
  handle?: string
  headers?: Record<string, string>
  [key: string]: unknown
}

/**
 * Adds the headers to static files in a Vercel Build Output config. The route goes in the `hit` phase, which runs only
 * when a static file matches, so it never changes a function response. A header that a route already sets is left out.
 */
export function addSecurityHeadersToVercelConfig(config: { routes?: VercelRoute[] }, headers: SecurityPolicy["headers"]): { routes?: VercelRoute[] } {
  const routes = [...config.routes ?? []]
  const present = new Set(routes.flatMap(route => Object.keys(route.headers ?? {})).map(name => name.toLowerCase()))
  const missing = headers.filter(([name]) => !present.has(name.toLowerCase()))
  if (missing.length === 0) return config
  const route = { src: "/(.*)", headers: Object.fromEntries(missing), continue: true }
  const hit = routes.findIndex(candidate => candidate.handle === "hit")
  if (hit >= 0) routes.splice(hit + 1, 0, route)
  else {
    // `error` is the last phase. The `hit` phase goes before it.
    const error = routes.findIndex(candidate => candidate.handle === "error")
    routes.splice(error >= 0 ? error : routes.length, 0, { handle: "hit" }, route)
  }
  return { ...config, routes }
}

interface NitroLike {
  hooks: { hook(name: "compiled", callback: () => Promise<void>): unknown }
  options: { baseURL: string, dev: boolean, output: { dir: string, publicDir: string }, preset?: string }
}

/**
 * Cloudflare, Netlify, and Vercel serve static files without the server, so the runtime cannot add headers to them.
 * This Nitro module writes the headers into the host's header config after the preset writes it. Node and Deno serve
 * static files through Nitro, which the runtime covers.
 */
export function securityHeadersNitroModule(headers: SecurityPolicy["headers"]): (nitro: NitroLike) => void {
  return (nitro: NitroLike) => {
    if (nitro.options.dev) return
    const host = hostFromNitroPreset(nitro.options.preset)
    if (host !== "cloudflare" && host !== "netlify" && host !== "vercel") return
    nitro.hooks.hook("compiled", async () => {
      if (host === "vercel") {
        const file = join(nitro.options.output.dir, "config.json")
        const config = JSON.parse(await readFile(file, "utf8")) as { routes?: VercelRoute[] }
        await writeFile(file, `${JSON.stringify(addSecurityHeadersToVercelConfig(config, headers), null, 2)}\n`, "utf8")
        return
      }
      // Both presets write `_headers` to the public directory without the base URL.
      const publicDir = nitro.options.output.publicDir.replace(/\/+$/, "")
      const base = nitro.options.baseURL.replace(/\/+$/, "")
      const file = join(base && publicDir.endsWith(base) ? publicDir.slice(0, -base.length) : publicDir, "_headers")
      const contents = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      await writeFile(file, addSecurityHeadersToHeadersFile(contents, headers, nitro.options.baseURL), "utf8")
    })
  }
}
