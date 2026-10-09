import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const agentFile: PrimitiveProjectFile = {
  path: "server/agents/greeting.ts",
  language: "typescript",
  content: `import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  driver: {
    run({ prompt }) {
      const name = typeof prompt === "string" ? prompt : "friend"
      return { text: "Hello, " + name + "." }
    },
  },
})`,
};

const viteConfig: PrimitiveProjectFile = {
  path: "vite.config.ts",
  language: "typescript",
  content: `import { defineConfig } from "vite"
import { nitro } from "nitro/vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ preset: "node", agent: true }),
    // Nitro's Vite plugin has a prerelease type identity.
    nitro() as never,
  ],
})`,
};

export const AgentsLanding = {
  slug: "agents",
  name: "Agents",
  docsTo: "/docs/agents",
  eyebrow: "ViteHub Agents",
  description: "Give coding Agents a real workspace, tools, and a portable runtime that can move with your app.",
  tagline: "Build Agents that can act in a real project and keep their context.",
  accent: "primary",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [agentFile, viteConfig, {
        path: "README.md",
        language: "markdown",
        content: "Add these files to an ESM Vite application. Install vite-hub and nitro, then run pnpm vite dev. The greeting Agent uses a local Driver and needs no model credentials.",
      }],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [agentFile, viteConfig, {
        path: "README.md",
        language: "markdown",
        content: "Nitro is integrated through Vite. Add these files to an ESM Vite application, install vite-hub and nitro, then run pnpm vite dev. ViteHub configures Nitro's Node preset; no standalone Nitro module is required.",
      }],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [agentFile, {
        path: "nuxt.config.ts",
        language: "typescript",
        content: `import { defineNuxtConfig } from "nuxt/config"
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [[viteHubNuxt, { preset: "node", agent: true }]],
})`,
      }, {
        path: "README.md",
        language: "markdown",
        content: "Add these files to a Nuxt 4.5.2 or newer application. Install vite-hub, then run pnpm nuxt dev. Nuxt provides Nitro. The greeting Agent uses a local Driver and needs no model credentials.",
      }],
    },
  ],
} satisfies PrimitiveLanding;
