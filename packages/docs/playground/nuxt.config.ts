import { fileURLToPath } from "node:url"

import { mediaRoute, publicUrl } from "./site.ts"

export default defineNuxtConfig({
  // This app always runs on Workers. Use its model-backed assistant during Node prerendering too.
  alias: { "@vite-hub/docs/assistant": fileURLToPath(new URL("../dist/assistant-worker.js", import.meta.url)) },
  modules: [
    ["vite-hub/nuxt", {
      host: "cloudflare",
      name: "vitehub-docs-demo",
      publicUrl,
      auth: true,
      kv: false,
      // The docs assistant: an Agent on the ChatGPT plan, and the Connection that holds the grant.
      // This Worker has no default Database, so its Invocation journal stays in memory, including during prerender.
      agent: { invocations: "memory" },
      connections: {
        management: { actor: fileURLToPath(new URL("./server/connections-auth.ts", import.meta.url)) },
        database: "users",
      },
      // Two R2 buckets. `default` holds the CMS history, which only the Worker reads. `media` is the media library of
      // the Console, served at /media for the illustrations and covers on the pages.
      blob: {
        stores: {
          default: { driver: "cloudflare-r2", binding: "BLOB", bucketName: "vitehub-docs-demo" },
          media: { driver: "cloudflare-r2", binding: "BLOB_MEDIA", bucketName: "vitehub-docs-demo-media" },
        },
        serve: {
          store: "media",
          route: mediaRoute,
          headers: {
            "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
            "X-Content-Type-Options": "nosniff",
            // Editors upload SVG files. Opened on their own, they run no script.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        },
      },
      // `authorize` is an absolute path: with an `app/` folder, ViteHub resolves a relative one from `app/`.
      console: {
        authorize: fileURLToPath(new URL("./server/console-authorize.ts", import.meta.url)),
      },
    }],
    "@vite-hub/docs/nuxt",
  ],
  docs: {
    site: {
      name: "Lumen",
      url: publicUrl,
      description: "Resize, compress, and convert images from the command line.",
      badge: { label: "demo", tooltip: "A made-up product. This site shows @vite-hub/docs on Cloudflare Workers." },
    },
    categories: ["Start", "Build", "Reference", "Demo"],
    railExclude: ["Reference"],
    start: { section: "getting-started", links: [
      { label: "All docs", to: "/docs", icon: "i-lucide-layout-grid" },
      { label: "Blog", to: "/blog", icon: "i-lucide-newspaper" },
      { label: "Changelog", to: "/changelog", icon: "i-lucide-history" },
      { label: "About", to: "/about", icon: "i-lucide-info" },
    ] },
    banner: "This is a demo of @vite-hub/docs. Sign in to edit the pages, comment on them, and connect your agent.",
    github: { repo: "vite-hub/vitehub", dir: "packages/docs/playground/content" },
    socials: [{ label: "ViteHub", to: "https://vitehub.dev", icon: "i-lucide-globe" }],
    mcp: { name: "lumen", guide: "/docs/this-site/connect-your-agent" },
    assistant: true,
  },
  // Static assets answer before the Worker on Cloudflare. The Console preview of a draft and the Markdown answer to
  // `Accept: text/markdown` need the Worker, so it runs first for the pages and the page JSON. vitehub.dev gets the same
  // rules from a local patch of nuxt-agent-discovery that installed apps do not get.
  nitro: {
    cloudflare: { wrangler: { assets: { run_worker_first: ["/", "/about", "/docs", "/docs/*", "/api/_docs/*"] } } },
    // The crawler follows the links of the prerendered pages. These routes read the CMS or the media library, which the
    // build cannot reach.
    prerender: { ignore: ["/blog", "/changelog", mediaRoute, /^\/_vitehub(?:\/|$)/] },
  },
  // The Worker renders the blog, the changelog, their feeds, the media library, and the Console at request time, so the
  // build output has no file for them. Nuxt Link Checker and the docs link check both read this list.
  linkChecker: { excludeLinks: [/^\/(?:blog|changelog|_vitehub)(?:\/|$)/, new RegExp(`^${mediaRoute}/`)] },
  // The blog and the changelog read the CMS when a page is requested, so the build does not prerender them. Each Worker
  // keeps a copy for a minute; Console previews skip it.
  routeRules: {
    "/blog": { prerender: false, swr: 60 },
    "/blog/**": { prerender: false, swr: 60 },
    "/changelog": { prerender: false, swr: 60 },
    "/changelog/**": { prerender: false, swr: 60 },
    "/api/blog/**": { swr: 60 },
    "/api/changelog/**": { swr: 60 },
  },
  compatibilityDate: "2026-11-01",
})
