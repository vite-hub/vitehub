import { defineNuxtConfig } from "nuxt/config";
import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  extends: ["docus"],
  modules: ["./modules/vitehub-docs", "@vite-hub/ui/nuxt", "nuxt-schema-org"],
  site: {
    description: "Portable Agents and Server Primitives for any Vite host.",
    name: "ViteHub",
    url: "https://vitehub.dev",
  },
  schemaOrg: {
    defaults: false,
  },
  llms: {
    domain: "https://vitehub.dev",
    title: "ViteHub",
    description: "Portable Agents and Server Primitives for any Vite host.",
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
  app: {
    head: {
      link: [
        { rel: "icon", type: "image/png", href: "/favicon.png" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      ],
    },
  },
  css: ["~/assets/main.css"],
  vite: {
    resolve: {
      alias: {
        debug: fileURLToPath(new URL("./app/shims/debug.ts", import.meta.url)),
        extend: fileURLToPath(new URL("./app/shims/extend.ts", import.meta.url)),
      },
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
      collections: ["lucide", "ph", "simple-icons", "vscode-icons"],
    },
    clientBundle: {
      scan: true,
      icons: [
        "lucide:brain",
        "lucide:check",
        "lucide:chevron-down",
        "lucide:chevron-right",
        "lucide:chevron-up",
        "lucide:code-2",
        "lucide:copy",
        "lucide:hash",
        "lucide:lightbulb",
        "lucide:menu",
        "lucide:paperclip",
        "lucide:moon",
        "lucide:search",
        "lucide:sun",
        "lucide:terminal",
        "lucide:text-align-start",
        "lucide:x",
        "ph:activity-light",
        "ph:arrows-split-light",
        "ph:book-bookmark-light",
        "ph:book-open-light",
        "ph:brain-light",
        "ph:broadcast-light",
        "ph:browser-light",
        "ph:calendar-check-light",
        "ph:caret-down-light",
        "ph:chart-bar-light",
        "ph:chat-circle-text-light",
        "ph:chat-text-light",
        "ph:chats-circle-light",
        "ph:clipboard-text-light",
        "ph:cloud-arrow-up-light",
        "ph:cloud-light",
        "ph:code-light",
        "ph:cpu-light",
        "ph:cube-light",
        "ph:database-light",
        "ph:door-open-light",
        "ph:download-simple-light",
        "ph:file-code-light",
        "ph:file-light",
        "ph:file-magnifying-glass-light",
        "ph:file-text-light",
        "ph:files-light",
        "ph:folder-light",
        "ph:folder-notch-open-light",
        "ph:folder-plus-light",
        "ph:gauge-light",
        "ph:git-branch-light",
        "ph:git-pull-request-light",
        "ph:hard-drives-light",
        "ph:identification-card-light",
        "ph:key-light",
        "ph:lightning-light",
        "ph:list-checks-light",
        "ph:list-numbers-light",
        "ph:magnifying-glass-light",
        "ph:map-trifold-light",
        "ph:markdown-logo-light",
        "ph:package-light",
        "ph:paper-plane-tilt-light",
        "ph:path-light",
        "ph:play-circle-light",
        "ph:plug-light",
        "ph:robot-light",
        "ph:rocket-launch-light",
        "ph:scroll-light",
        "ph:seal-check-light",
        "ph:shield-check-light",
        "ph:shield-warning-light",
        "ph:sliders-horizontal-light",
        "ph:squares-four-light",
        "ph:stethoscope-light",
        "ph:terminal-light",
        "ph:terminal-window-light",
        "ph:text-h-light",
        "ph:tree-structure-light",
        "ph:triangle-light",
        "ph:user-check-light",
        "ph:users-three-light",
        "ph:warning-circle-light",
        "ph:waveform-light",
        "ph:wrench-light",
        "simple-icons:cloudflare",
        "simple-icons:discord",
        "simple-icons:vercel",
        "vscode-icons:file-type-typescript",
      ],
    },
  },
  devtools: {
    enabled: false,
  },
  nitro: {
    preset: "cloudflare_module",
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: "vitehub-docs",
        compatibility_date: "2026-07-19",
        workers_dev: false,
        preview_urls: true,
        d1_databases: [
          {
            binding: "DB",
            database_id:
              process.env.CLOUDFLARE_D1_DATABASE_ID ??
              "00000000-0000-0000-0000-000000000000",
            database_name: "vitehub-docs",
          },
        ],
        routes: [
          {
            pattern: "vitehub.dev",
            custom_domain: true,
          },
        ],
        observability: {
          enabled: true,
          head_sampling_rate: 0.1,
        },
      },
    },
    prerender: {
      failOnError: true,
      routes: ["/about", "/contact", "/openapi.json", "/privacy"],
    },
  },
  future: {
    compatibilityVersion: 4,
  },
  compatibilityDate: "2026-05-30",
  experimental: {
    payloadExtraction: false,
    defaults: {
      nuxtLink: {
        trailingSlash: "append",
      },
    },
  },
});
