import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

export const SourceLanding = {
  ...stubLanding("source", "Source", "/docs/source"),
  eyebrow: "ViteHub Source",
  description: "Read content from local files, records, or remote providers with one typed access contract.",
  tagline: "Read the project without giving it away.",
  accent: "info",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [
        { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite"\n  },\n  "dependencies": {\n    "vite": "^8.0.0",\n    "nitro": "3.0.261102-rc",\n    "vite-hub": "latest"\n  }\n}' },
        {
          path: "vite.config.ts",
          language: "typescript",
          content: 'import { nitro } from "nitro/vite"\nimport { defineConfig } from "vite"\nimport { vitehub } from "vite-hub"\n\nexport default defineConfig({\n  plugins: [vitehub({ host: "node" }), nitro({ serverDir: "./server" })],\n})',
        },
        {
          path: "server/api/docs.get.ts",
          language: "typescript",
          content:
            'import { defineEventHandler } from "nitro/h3"\nimport { createSource, glob } from "vite-hub/source"\n\nexport default defineEventHandler(async () => {\n  const docs = glob({ cwd: "docs", include: "**/*.md" })\n  return createSource(docs).read("intro.md")\n})',
        },
        { path: "docs/intro.md", language: "markdown", content: "# Introduction\n\nRead this content through Source." },
      ],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "nitro dev"\n  },\n  "dependencies": {\n    "nitro": "3.0.261102-rc",\n    "vite-hub": "latest"\n  }\n}' },
        {
          path: "nitro.config.ts",
          language: "typescript",
          content: 'import { defineNitroConfig } from "nitro/config"\n\nexport default defineNitroConfig({ serverDir: "./server" })',
        },
        {
          path: "server/api/docs.get.ts",
          language: "typescript",
          content:
            'import { defineEventHandler } from "nitro/h3"\nimport { createSource, glob } from "vite-hub/source"\n\nexport default defineEventHandler(async () => {\n  const docs = glob({ cwd: "docs", include: "**/*.md" })\n  return createSource(docs).read("intro.md")\n})',
        },
        { path: "docs/intro.md", language: "markdown", content: "# Introduction\n\nRead this content through Source." },
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        { path: "package.json", language: "json", content: '{\n  "private": true,\n  "type": "module",\n  "engines": {\n    "pnpm": ">=11.5.0"\n  },\n  "scripts": {\n    "dev": "nuxt dev"\n  },\n  "dependencies": {\n    "nuxt": "npm:nuxt-nightly@5x",\n    "h3": "2.0.8",\n    "vite-hub": "latest"\n  }\n}' },
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: 'export default defineNuxtConfig({\n  modules: ["vite-hub/nuxt"],\n  vitehub: { host: "node" }\n})',
        },
        {
          path: "server/api/docs.get.ts",
          language: "typescript",
          content:
            'import { defineEventHandler } from "h3"\nimport { createSource, glob } from "vite-hub/source"\n\nexport default defineEventHandler(async () => {\n  const docs = glob({ cwd: "docs", include: "**/*.md" })\n  return createSource(docs).read("intro.md")\n})',
        },
        { path: "docs/intro.md", language: "markdown", content: "# Introduction\n\nRead this content through Source." },
      ],
    },
  ],
} satisfies PrimitiveLanding;
