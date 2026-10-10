import type { PrimitiveLanding } from "./types";

const definition = {
  path: "server/schedules/daily-report.ts",
  language: "typescript",
  content: `import { defineSchedule } from "@vite-hub/schedule"

export default defineSchedule({
  cron: "0 8 * * *",
  handler({ scheduledAt }) {
    console.log("Daily report", scheduledAt)
  },
})`,
};

export const ScheduleLanding = {
  slug: "schedule",
  name: "Schedule",
  docsTo: "/docs/schedule",
  eyebrow: "ViteHub Schedule",
  description: "Run recurring work with a typed schedule that belongs to your server code.",
  tagline: "Recurring work that follows the same contract everywhere.",
  accent: "secondary",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `import { hubSchedule } from "@vite-hub/schedule/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubSchedule()],
})`,
        },
        definition,
      ],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `import { hubSchedule } from "@vite-hub/schedule/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubSchedule(), nitro()],
})`,
        },
        definition,
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: `export default defineNuxtConfig({
  modules: ["@vite-hub/schedule/nuxt"],
})`,
        },
        definition,
      ],
    },
  ],
} satisfies PrimitiveLanding;
