import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const contentFiles: PrimitiveProjectFile[] = [
  {
    path: "server/content.ts",
    language: "typescript",
    content: `import sqlite from "comark-content/database/sqlite-node"
import sqliteFullTextSearch from "comark-content/plugins/sqlite-full-text-search"
import { defineContent } from "vite-hub/content"
import { glob } from "vite-hub/source/glob"

export const content = defineContent({
  plugins: [sqliteFullTextSearch({ database: sqlite() })],
  sources: {
    docs: glob({ cwd: "docs", include: "**/*.md" }),
  },
})`,
  },
  {
    path: "docs/guide.md",
    language: "markdown",
    content: "# Welcome\n\nParse, query, and search your documents with ViteHub Content.",
  },
];

function packageFile(framework: "vite" | "nitro" | "nuxt"): PrimitiveProjectFile {
  return {
    path: "package.json",
    language: "json",
    content: JSON.stringify({
      private: true,
      type: "module",
      scripts: { dev: framework === "vite" ? "vite" : `${framework} dev` },
      dependencies: {
        "vite-hub": "^0.0.4",
        "comark-content": "0.4.1",
        ...(framework === "nuxt" ? { nuxt: "^4.5.2" } : {}),
        ...(framework === "vite" || framework === "nitro" ? { nitro: "3.0.260903-beta" } : {}),
        ...(framework === "vite" ? { vite: "^8.2.2" } : {}),
      },
    }, null, 2),
  };
}

export const ContentLanding = {
  slug: "content",
  name: "Content",
  eyebrow: "ViteHub Content",
  description: "Parse and search content in the server layer so applications can work with documents directly.",
  tagline: "Content that is ready to query.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
  docsTo: "/docs/content",
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [
        packageFile("vite"),
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `import { defineConfig } from "vite"
import { nitro } from "nitro/vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({ preset: "node" }), nitro() as never],
})`,
        },
        ...contentFiles,
      ],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        packageFile("nitro"),
        {
          path: "nitro.config.ts",
          language: "typescript",
          content: `import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  serverDir: "server",
})`,
        },
        ...contentFiles,
        {
          path: "server/routes/api/content/[...path].ts",
          language: "typescript",
          content: `import { defineContentHandler } from "vite-hub/content"
import { content } from "../../../content"

export default defineContentHandler(content)`,
        },
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        packageFile("nuxt"),
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: `import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [[viteHubNuxt, { preset: "node" }]],
})`,
        },
        ...contentFiles,
      ],
    },
  ],
} satisfies PrimitiveLanding;
