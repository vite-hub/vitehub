import { ownModule } from "@vite-hub/internal/build/paths"

import { readProjectWranglerConfig } from "./cloudflare-custom-domain.ts"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { generatedNitroPlugin } from "./generated-nitro-plugin.ts"

import type { Plugin } from "vite"
import type { RedirectsPolicy } from "./_internal/runtime/redirects.ts"

/** `redirects` options of `vitehub()`. */
export interface RedirectsOptions {
  /**
   * The canonical host name, such as `"example.com"`. A request to another host, such as `www.example.com`, is
   * redirected to this host with the same path and query. Local names, IP addresses, and `previewHosts` keep their host.
   */
  host?: string
  /** Redirect `http:` requests to `https:`. Local names, IP addresses, and `previewHosts` keep their scheme. */
  https?: boolean
  /**
   * `"remove"` redirects `/pricing/` to `/pricing`. `"add"` redirects `/pricing` to `/pricing/`. It applies to page
   * requests only: `GET` and `HEAD`, not under `/api/` or `/_`, and without a file extension.
   */
  trailingSlash?: "add" | "remove"
  /**
   * More hosts that keep their host and scheme, such as `"staging.example.com"`. `*.` matches every subdomain. The
   * preview hosts of each host always do: `*.workers.dev`, `*.pages.dev`, `*.vercel.app`, `*.netlify.app`,
   * `*.deno.dev`, and `*.deno.net`.
   */
  previewHosts?: string[]
}

/** The preview hosts that never redirect. */
export const defaultPreviewHosts = ["*.workers.dev", "*.pages.dev", "*.vercel.app", "*.netlify.app", "*.deno.dev", "*.deno.net"] as const

const hostName = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** The resolved policy, or `undefined` when `redirects` redirects nothing. Throws for an invalid option. */
export function resolveRedirectsPolicy(options: RedirectsOptions | undefined): RedirectsPolicy | undefined {
  if (!options) return
  const { https, trailingSlash } = options
  const host = options.host?.trim().toLowerCase()
  if (host !== undefined && !hostName.test(host)) throw viteHubErrorDiagnostics.VITE_HUB_REDIRECTS_HOST_INVALID({ value: JSON.stringify(options.host) })
  if (trailingSlash !== undefined && trailingSlash !== "add" && trailingSlash !== "remove") {
    throw viteHubErrorDiagnostics.VITE_HUB_REDIRECTS_TRAILING_SLASH_INVALID({ value: JSON.stringify(trailingSlash) ?? String(trailingSlash) })
  }
  const previewHosts = (options.previewHosts ?? []).map((pattern) => {
    const value = typeof pattern === "string" ? pattern.trim().toLowerCase() : ""
    if (!hostName.test(value.startsWith("*.") ? value.slice(2) : value)) {
      throw viteHubErrorDiagnostics.VITE_HUB_REDIRECTS_PREVIEW_HOST_INVALID({ value: JSON.stringify(pattern) ?? String(pattern) })
    }
    return value
  })
  if (!host && !https && !trailingSlash) return
  return {
    ...host ? { host } : {},
    ...https ? { https: true } : {},
    ...trailingSlash ? { trailingSlash } : {},
    previewHosts: [...new Set([...defaultPreviewHosts, ...previewHosts])],
  }
}

/** Render the Nitro plugin that installs `redirects` in built output. `vite dev` never redirects. */
export function renderRedirectsNitroPlugin(policy: RedirectsPolicy): string {
  return [
    `import { installRedirects } from ${JSON.stringify(ownModule(import.meta.url, "_internal/runtime/redirects"))}`,
    "",
    "export default function viteHubRedirectsPlugin(nitroApp) {",
    "  if (import.meta.dev) return",
    `  installRedirects(nitroApp, ${JSON.stringify(policy)})`,
    "}",
    "",
  ].join("\n")
}

interface NitroLike {
  hooks: { hook(name: "build:before", callback: () => void): unknown }
  options: {
    baseURL: string
    cloudflare?: { wrangler?: Record<string, unknown> }
    dev: boolean
    entry: string
    preset?: string
    publicAssets: Array<{ baseURL?: string, fallthrough?: boolean }>
    rootDir: string
    static?: boolean
    virtual: Record<string, string | (() => string)>
  }
}

const cloudflareEntry = "#vitehub/virtual/redirects-entry"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * The Wrangler `assets` keys for `redirects`. Cloudflare serves a static file, such as a prerendered page, before the
 * Worker runs, so the Worker could not redirect it. `run_worker_first` sends every request to the Worker first, except
 * the build assets with hashed names, such as `/_nuxt/*`, which need no redirect. `html_handling` makes Cloudflare's own
 * trailing-slash redirect of HTML files go the same way. A key that the app sets itself is kept.
 */
export function cloudflareRedirectsAssets(
  policy: RedirectsPolicy,
  nitro: Pick<NitroLike["options"], "baseURL" | "publicAssets">,
  configured: Record<string, unknown>,
): Record<string, unknown> {
  const base = nitro.baseURL.endsWith("/") ? nitro.baseURL : `${nitro.baseURL}/`
  const buildAssets = nitro.publicAssets
    .filter(asset => !asset.fallthrough && asset.baseURL && asset.baseURL !== "/")
    .map(asset => `!${base}${asset.baseURL!.replace(/^\/+|\/+$/g, "")}/*`)
  return {
    ...configured.run_worker_first === undefined ? { run_worker_first: [`${base}*`, ...new Set(buildAssets)] } : {},
    ...policy.trailingSlash && configured.html_handling === undefined
      ? { html_handling: policy.trailingSlash === "add" ? "force-trailing-slash" : "drop-trailing-slash" }
      : {},
  }
}

/**
 * On Cloudflare, wraps the Worker entry so the redirect runs before a static file is served, and writes the Wrangler
 * `assets` keys of {@link cloudflareRedirectsAssets}. Other hosts send every request that the server sees through
 * `nitroApp.fetch`, which the Nitro plugin covers.
 */
export function redirectsNitroModule(policy: RedirectsPolicy): (nitro: NitroLike) => void {
  return (nitro: NitroLike) => {
    const preset = nitro.options.preset?.replaceAll("_", "-")
    if (nitro.options.dev || nitro.options.static || (preset !== "cloudflare-module" && preset !== "cloudflare-durable")) return
    const entry = nitro.options.entry
    nitro.options.virtual[cloudflareEntry] = [
      `import handler from ${JSON.stringify(entry)}`,
      `import { withCloudflareRedirects } from ${JSON.stringify(ownModule(import.meta.url, "_internal/runtime/redirects"))}`,
      `export * from ${JSON.stringify(entry)}`,
      `export default withCloudflareRedirects(handler, ${JSON.stringify(policy)})`,
      "",
    ].join("\n")
    nitro.options.entry = cloudflareEntry
    nitro.hooks.hook("build:before", () => {
      const cloudflare = nitro.options.cloudflare ??= {}
      const wrangler = cloudflare.wrangler ??= {}
      const assets = record(wrangler.assets)
      const project = record(readProjectWranglerConfig(nitro.options.rootDir)?.assets)
      wrangler.assets = { ...assets, ...cloudflareRedirectsAssets(policy, nitro.options, { ...project, ...assets }) }
    })
  }
}

/** Generates the redirect code of `vitehub({ redirects })`. Without a policy, ViteHub generates nothing. */
export function redirectsVitePlugin(policy: RedirectsPolicy): Plugin {
  return generatedNitroPlugin("vite-hub/redirects", "redirects.mjs", () => renderRedirectsNitroPlugin(policy), {
    position: "start",
    configure: (nitro: Record<string, unknown>) => {
      nitro.modules = [...Array.isArray(nitro.modules) ? nitro.modules : [], redirectsNitroModule(policy)]
    },
  })
}
