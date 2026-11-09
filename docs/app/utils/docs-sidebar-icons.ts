import type { DocsIcons } from "@vite-hub/docs";

/**
 * Icons of the docs rail and sidebar, passed to the `docs.icons` option in `nuxt.config.ts`.
 * Sections use the ViteHub set (`i-vitehub-*` in each `.navigation.yml`), the same icons as the Console. Pages show
 * Lucide icons only, so a frontmatter icon of another set maps to Lucide.
 */
export const docsIcons: Partial<DocsIcons> = {
  family: ["i-lucide-", "i-vitehub-"],
  page: "i-lucide-file-text",
  section: "i-lucide-folder",
  /** Brand icons in frontmatter map to Lucide, so every sidebar page row shares one style. */
  aliases: {
    "i-simple-icons-vite": "i-lucide-zap",
    "i-simple-icons-cloudflare": "i-lucide-cloud",
    "i-simple-icons-vercel": "i-lucide-triangle",
    "i-vscode-icons-file-type-markdown": "i-lucide-file-text",
  },
  sections: {
    "ai-resources": "i-lucide-brain",
  },
  pages: {
    "/docs/agents": "i-lucide-activity",
    "/docs/agents/capabilities": "i-lucide-sliders-horizontal",
    "/docs/getting-started/concepts": "i-lucide-book-marked",
    "/docs/frameworks-hosts": "i-lucide-zap",
    "/docs/getting-started": "i-lucide-book-open",
    "/docs/getting-started/server-primitives": "i-lucide-box",
    "/docs/reference": "i-lucide-package",
  },
};
