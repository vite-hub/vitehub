import type { PrimitiveLanding } from "./types";

export const LogsLanding = {
  slug: "logs",
  name: "Logs",
  docsTo: "/docs/logs",
  eyebrow: "ViteHub Logs",
  description: "Use Evlog for structured events and inspect your existing pipeline in the Console.",
  tagline: "Your events, with their full context.",
  accent: "info",
  supported: ["Vite", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite + Nitro",
      files: [
        {
          path: "package.json",
          language: "json",
          content: JSON.stringify(
            {
              name: "logs-starter",
              private: true,
              type: "module",
              scripts: { dev: "vite" },
              dependencies: {
                "vite-hub": "latest",
                evlog: "^2.28.1",
                nitro: "3.0.260903-beta",
                vite: "^8.2.2",
              },
            },
            null,
            2,
          ),
        },
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ preset: "node", logs: true, console: { auth: false, local: true } }),
    nitro(),
  ],
})`,
        },
        {
          path: "server/api/status.get.ts",
          language: "typescript",
          content: `import { useLogger } from "evlog/nitro/v3"
import { defineHandler } from "nitro/h3"

export default defineHandler((event) => {
  useLogger(event).set({ message: "Status checked" })
  return { ok: true }
})`,
        },
        {
          path: "README.md",
          language: "markdown",
          content: `# Local Logs

Use Node.js 24.15 or newer. Run pnpm install, then pnpm dev.
Request /api/status, then open /_vitehub/logs to inspect the event.
This starter uses temporary development capture. It has no production build script.
For production, connect an existing backend with logs.source.
See https://vitehub.dev/docs/logs/configure for the read contract.`,
        },
      ],
    },
  ],
} satisfies PrimitiveLanding;
