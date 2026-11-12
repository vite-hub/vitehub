import { defineNuxtConfig } from "nuxt/config";
import { fileURLToPath } from "node:url";
import { docsIcons } from "./app/utils/docs-sidebar-icons";
import { capabilityReferences, expandCapabilityTools } from "./modules/vitehub-docs/capability-references";

export default defineNuxtConfig({
  // The diagnostics module writes its pages before `@vite-hub/docs` reads the content folder.
  modules: ["./modules/diagnostics", "@vite-hub/docs/nuxt", "./modules/vitehub-docs", "./modules/tutorials", "nuxt-schema-org"],
  // The docs Worker's server maps exceed Cloudflare's 60 MiB encoded-sourcemap limit.
  sourcemap: { server: false },
  docs: {
    site: {
      name: "ViteHub",
      url: "https://vitehub.dev",
      description: "Portable Agents for Vite, built on Server Primitives.",
      logo: "/vitehub-mark.svg",
      badge: { label: "alpha", tooltip: "Just a library where I test different solutions and agents. APIs break all the time." },
    },
    categories: ["Start", "Agents", "UI", "Data", "Compute", "Access", "Delivery", "Files", "Develop and deploy", "Reference"],
    railExclude: ["Develop and deploy", "Reference"],
    start: {
      section: "getting-started",
      links: [
        { label: "All docs", to: "/docs", icon: "i-lucide-layout-grid" },
        { label: "Learn", to: "/learn", icon: "i-lucide-graduation-cap" },
        { label: "Playground", to: "/playground", icon: "i-lucide-code" },
        { label: "Projects", to: "/projects", icon: "i-lucide-folder" },
        { label: "Templates", to: "/templates", icon: "i-lucide-layout-template" },
        // The Console opens deployed ViteHub apps. See /docs/development/console#in-production.
        { label: "Console", to: "https://console.vitehub.dev", icon: "i-lucide-monitor" },
      ],
    },
    socials: [{ label: "ViteHub on Discord", icon: "i-simple-icons-discord", to: "https://chat.vitehub.dev" }],
    footer: [
      { label: "About", to: "/about" },
      { label: "Examples", to: "/examples" },
      { label: "Contact", to: "/contact" },
      { label: "Privacy", to: "/privacy" },
    ],
    banner: "ViteHub is still experimental. Expect bugs and breaking changes.",
    github: { repo: "vite-hub/vitehub", dir: "docs/content" },
    icons: docsIcons,
    mcp: { name: "vitehub", guide: "/docs/getting-started/ai-resources/mcp-server" },
    sitemap: ["/learn", "/playground", "/examples", "/projects", "/templates"],
    // Fail the build on pages that a site audit would flag: see DocsSeoError.
    seoAudit: "error",
    // Agents read the tool contract of each `::agent-capability-tools` block that the site renders as a component.
    rawMarkdown: async (markdown: string) => expandCapabilityTools(markdown, await capabilityReferences()),
    // Rules for every task, printed under the llms.txt description. Page-level detail lives in `::agent-only` blocks.
    llms: {
      details: [
        "Rules for coding agents:",
        [
          "- Read the installed package exports and types before you write imports or options. When the installed packages, these docs, and remembered syntax disagree, follow the installed packages.",
          "- Prefer the `vite-hub` distribution: register `vitehub()` from `vite-hub` in the Vite config and import Runtime Helpers from feature subpaths such as `vite-hub/kv`. Some pages use owner packages such as `@vite-hub/kv`; follow the style that the project already uses.",
          "- Keep provider and host selection in the Vite config. Application code calls the same Runtime Helper on every host.",
          "- Give an Agent authority only through Capabilities, Workspaces, Sources, or Channels. Do not pass application secrets or broad access to an Agent implicitly.",
          "- Open the raw page for one feature, such as `https://vitehub.dev/raw/docs/kv.md`, before you write code. Raw pages contain agent-only details that the rendered site does not show. Do not load llms-full.txt for one task.",
          "- Prove the change: run the Runtime Helper, Agent Invocation, webhook, or schedule, and inspect the generated `.vitehub/` state or provider output.",
          "- Install the ViteHub skill for routed guidance: `npx skills add https://vitehub.dev --skill vitehub`.",
        ].join("\n"),
      ].join("\n\n"),
      sections: [
        {
          title: "When to use ViteHub",
          description: "Use ViteHub when a Vite application needs portable server storage, queues, workflows, schedules, sandboxes, or other Server Primitives; when it needs inspectable Agent Definitions with explicit Capabilities and Workspaces; or when the same runtime behavior must deploy across supported hosts without leaking provider APIs into application code.",
          links: [
            {
              title: "Choose a ViteHub layer",
              description: "Decide whether the job needs a Server Primitive, an Agent, or both.",
              href: "https://vitehub.dev/raw/docs/getting-started.md",
            },
            {
              title: "Install ViteHub",
              description: "Install the framework distribution or a focused owner package.",
              href: "https://vitehub.dev/raw/docs/getting-started/installation.md",
            },
            {
              title: "Compare ViteHub",
              description: "Compare ViteHub with NuxtHub, Mastra, and the Cloudflare Agents SDK, and see when ViteHub is the wrong choice.",
              href: "https://vitehub.dev/raw/docs/compare.md",
            },
            {
              title: "Agent harness",
              description: "See how ViteHub runs Codex, Claude Code, or a model loop with Capabilities, Workspaces, Sandboxes, and approvals.",
              href: "https://vitehub.dev/raw/docs/agents/harness.md",
            },
          ],
        },
        {
          title: "ViteHub developer resources",
          description: "Use these named machine interfaces to inspect ViteHub before reading the full documentation set. ViteHub is installed into your application and does not expose a shared hosted runtime API.",
          links: [
            {
              title: "ViteHub OpenAPI document",
              description: "Discover the public machine-readable resources served by vitehub.dev.",
              href: "https://vitehub.dev/openapi.json",
            },
            {
              title: "ViteHub Agent Skill",
              description: "Install or inspect the coding-agent instructions and routed references.",
              href: "https://vitehub.dev/.well-known/skills/vitehub/SKILL.md",
            },
            {
              title: "ViteHub MCP server",
              description: "Connect an MCP client to the Streamable HTTP documentation endpoint.",
              href: "https://vitehub.dev/mcp",
            },
            {
              title: "ViteHub CLI on npm",
              description: "Install the official CLI included with the vite-hub package.",
              href: "https://www.npmjs.com/package/vite-hub",
            },
          ],
        },
        {
          title: "Project and trust information",
          links: [
            { title: "About ViteHub", href: "https://vitehub.dev/raw/about.md" },
            { title: "Contact ViteHub", href: "https://vitehub.dev/raw/contact.md" },
            { title: "ViteHub privacy", href: "https://vitehub.dev/raw/privacy.md" },
          ],
        },
      ],
    },
  },
  site: {
    description: "Portable Agents for Vite, built on Server Primitives.",
    name: "ViteHub",
    url: "https://vitehub.dev",
  },
  schemaOrg: {
    defaults: false,
  },
  agentDiscovery: {
    discovery: {
      links: [
        { href: "/openapi.json", rel: "service-desc", type: "application/vnd.oai.openapi+json", title: "OpenAPI document: every route this site serves to agents", anchor: "/" },
      ],
    },
  },
  app: {
    head: {
      // One static preview for every page. Crawlers such as X and Slack read these tags from the server HTML.
      // Regenerate the image with `node docs/scripts/og-images.mjs`.
      meta: [
        { property: "og:image", content: "https://vitehub.dev/og/vitehub.png" },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:alt", content: "ViteHub: the server layer for Vite apps." },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: "https://vitehub.dev/og/vitehub.png" },
        { name: "twitter:image:alt", content: "ViteHub: the server layer for Vite apps." },
      ],
      link: [
        { rel: "icon", type: "image/png", href: "/favicon.png" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      ],
    },
  },
  css: ["~/assets/main.css"],
  postcss: {
    plugins: {
      cssnano: {
        // postcss-calc 10.1.1 rejects comark-chat's valid nested calc() fallback. Let browsers evaluate it.
        preset: ["default", { calc: false }],
      },
    },
  },
  vite: {
    resolve: {
      alias: [
        // Keep Shiki's WebAssembly in the Worker bundle; Cloudflare deployments do not ship node_modules.
        // `shiki/wasm` resolves to onig.wasm under the `unwasm` condition of the Cloudflare server build.
        { find: /^shiki\/wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
        { find: /^shiki\/dist\/onig\.wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
        { find: /(?:^|[/\\])shiki[/\\]dist[/\\]onig\.wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
        { find: "debug", replacement: fileURLToPath(new URL("./app/shims/debug.ts", import.meta.url)) },
        { find: "extend", replacement: fileURLToPath(new URL("./app/shims/extend.ts", import.meta.url)) },
      ],
    },
  },
  icon: {
    provider: "server",
    fallbackToApi: false,
    customCollections: [
      {
        prefix: "unjs",
        dir: fileURLToPath(new URL("./app/assets/icons/unjs", import.meta.url)),
      },
    ],
    serverBundle: {
      collections: ["lucide", "simple-icons", "vscode-icons"],
    },
    // Server-rendered icons come with their CSS. Icons that appear only in the browser and are not listed here load from
    // the server bundle on first use, so the client bundle stays small instead of holding every icon in the source.
    clientBundle: {
      icons: [
        "lucide:activity",
        "lucide:app-window",
        "lucide:audio-lines",
        "lucide:badge-check",
        "lucide:book-marked",
        "lucide:book-open",
        "lucide:bot",
        "lucide:box",
        "lucide:brain",
        "lucide:calendar-check",
        "lucide:calendar-plus",
        "lucide:calendar-x",
        "lucide:chart-no-axes-column",
        "lucide:check",
        "lucide:chevron-down",
        "lucide:chevron-right",
        "lucide:chevron-up",
        "lucide:circle-alert",
        "lucide:circle-play",
        "lucide:clipboard-list",
        "lucide:cloud",
        "lucide:cloud-upload",
        "lucide:code",
        "lucide:code-2",
        "lucide:copy",
        "lucide:cpu",
        "lucide:database",
        "lucide:door-open",
        "lucide:download",
        "lucide:file",
        "lucide:file-code",
        "lucide:file-search",
        "lucide:file-text",
        "lucide:files",
        "lucide:folder",
        "lucide:folder-open",
        "lucide:folder-plus",
        "lucide:gauge",
        "lucide:git-branch",
        "lucide:git-compare",
        "lucide:git-pull-request",
        "lucide:graduation-cap",
        "lucide:hard-drive-download",
        "lucide:hard-drive-upload",
        "lucide:hash",
        "lucide:heading",
        "lucide:id-card",
        "lucide:key-round",
        "lucide:layout-grid",
        "lucide:layout-template",
        "lucide:library",
        "lucide:lightbulb",
        "lucide:list",
        "lucide:list-checks",
        "lucide:list-ordered",
        "lucide:map",
        "lucide:menu",
        "lucide:message-circle-code",
        "lucide:message-square-text",
        "lucide:messages-square",
        "lucide:monitor",
        "lucide:moon",
        "lucide:network",
        "lucide:package",
        "lucide:paperclip",
        "lucide:plug",
        "lucide:radio",
        "lucide:rocket",
        "lucide:route",
        "lucide:scroll-text",
        "lucide:search",
        "lucide:send",
        "lucide:server",
        "lucide:shield-alert",
        "lucide:shield-check",
        "lucide:sliders-horizontal",
        "lucide:square-terminal",
        "lucide:stethoscope",
        "lucide:sun",
        "lucide:terminal",
        "lucide:text-align-start",
        "lucide:triangle",
        "lucide:user-check",
        "lucide:users-round",
        "lucide:workflow",
        "lucide:wrench",
        "lucide:x",
        "lucide:zap",
        "simple-icons:cloudflare",
        "simple-icons:discord",
        "simple-icons:vercel",
        "vscode-icons:file-type-js-official",
        "vscode-icons:file-type-text",
        "vscode-icons:file-type-toml",
        "vscode-icons:file-type-typescript",
        "vscode-icons:file-type-yaml",
      ],
    },
  },
  devtools: {
    enabled: false,
  },
  nitro: {
    preset: "cloudflare_module",
    // Minify Nitro's emitted modules; its Wrangler config disables a second bundle.
    minify: true,
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: "vitehub-docs",
        // Minify the final upload, including the icon collections and server-rendered Markdown dependencies.
        minify: true,
        compatibility_date: "2026-07-19",
        workers_dev: false,
        preview_urls: true,
        upload_source_maps: false,
        d1_databases: [
          {
            binding: "DB",
            database_id: "4a8731af-1899-4d41-ac8b-6870167ead95",
            database_name: "vitehub-docs",
          },
        ],
        routes: [
          {
            pattern: "vitehub.dev",
            custom_domain: true,
          },
          // `server/middleware/canonical-url.ts` redirects this host to vitehub.dev.
          {
            pattern: "www.vitehub.dev",
            custom_domain: true,
          },
        ],
        assets: {
          // The Worker sees every page request, so www and trailing-slash URLs redirect
          // even when the page is prerendered. Build assets and robots.txt skip the Worker.
          run_worker_first: ["/*", "!/_nuxt/*", "!/robots.txt"],
        },
        observability: {
          enabled: true,
          head_sampling_rate: 0.1,
        },
      },
    },
    prerender: {
      failOnError: true,
      // The docs module adds every content page. These are app routes.
      routes: ["/openapi.json", "/robots.txt"],
    },
  },
  compatibilityDate: "2026-05-30",
  experimental: {
    payloadExtraction: false,
    defaults: {
      nuxtLink: {
        trailingSlash: "remove",
      },
    },
  },
});
