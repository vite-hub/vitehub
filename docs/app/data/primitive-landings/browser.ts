import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const browserFiles: PrimitiveProjectFile[] = [
  {
    path: "server/browsers/page-html.ts",
    language: "typescript",
    content: `import { defineBrowser } from "vite-hub/browser"

export default defineBrowser(async (input: { url: string }, { browser }) => {
  return await browser.content(input.url)
})`,
  },
  {
    path: "server/render-page.ts",
    language: "typescript",
    content: `import { runBrowser } from "vite-hub/browser"

// Call from trusted server code after the host generates the Browser registry.
export async function renderPage() {
  return await runBrowser("page-html", { url: "https://example.com" })
}`,
  },
];

export const BrowserLanding = {
  slug: "browser",
  name: "Browser",
  docsTo: "/docs/browser",
  eyebrow: "ViteHub Browser",
  description: "Give server code a controlled browser surface for pages, screenshots, and automation on Cloudflare Browser Run.",
  tagline: "Named browser operations for your server. The Agent browser Capability provides its own separate CLI.",
  accent: "secondary",
  supported: ["Vite + Nitro", "Nuxt", "Cloudflare Browser Run"],
  variants: [
    {
      framework: "vite",
      label: "Vite + Nitro",
      files: [
        ...browserFiles,
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `import { defineConfig } from "vite"
import { nitro } from "nitro/vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ preset: "cloudflare", browser: true }),
    // Nitro is runtime-compatible with Vite despite its prerelease type identity.
    nitro() as never,
  ],
})`,
        },
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        ...browserFiles,
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: `import { defineNuxtConfig } from "nuxt/config"
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "cloudflare", browser: true }],
  ],
})`,
        },
      ],
    },
  ],
} satisfies PrimitiveLanding;
