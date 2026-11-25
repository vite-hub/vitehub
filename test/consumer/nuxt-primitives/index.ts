import { access } from "./access.ts"
import { agents } from "./agents.ts"
import { content } from "./content.ts"
import { jobs } from "./jobs.ts"
import { ops } from "./ops.ts"
import { isRow, modes, type Mode, type PrimitiveEntry } from "./row.ts"
import { storage } from "./storage.ts"

export const entries: readonly PrimitiveEntry[] = [...storage, ...jobs, ...agents, ...content, ...access, ...ops]

export const notPrimitives: Readonly<Record<string, string>> = {
  cli: "The `vitehub` command, which the Database row runs.",
  docs: "A Nuxt module of its own, `vite-hub/docs/nuxt`, that `vite-hub/nuxt` does not install. It adds Nuxt UI and owns `/sitemap.xml`, `/mcp`, and the trailing-slash rule of the site, so it cannot share the primitives app. packages/docs/test/nuxt-consumer.test.ts builds it in a Nuxt app.",
  codemods: "Rewrites app source before it moves to ViteHub. It adds nothing to a Nuxt app.",
  presets: "Agent presets built from the other primitives.",
  runtime: "The shared error and request contracts of every primitive.",
  ui: "Vue parts that the other primitives render.",
}

const modeNames: Record<Mode, string> = {
  "node-build": "Node build",
  "node-dev": "Node dev",
  "cloudflare-build": "Cloudflare build",
  "cloudflare-dev": "Cloudflare dev",
}

export function renderNuxtSupportMatrix(): string {
  const cell = (entry: PrimitiveEntry, mode: Mode) => !isRow(entry) ? "Not checked yet" : entry.exempt?.[mode] ? "Not tested" : "Tested"
  const exempt = entries.filter(isRow).flatMap(row => modes.flatMap(mode => row.exempt?.[mode] ? [`- \`${row.id}\`, ${modeNames[mode]}: ${row.exempt[mode]}`] : []))
  return [
    `| Package | ${modes.map(mode => modeNames[mode]).join(" | ")} |`,
    `| --- |${modes.map(() => " --- |").join("")}`,
    ...entries.map(entry => `| \`${entry.id}\` | ${modes.map(mode => cell(entry, mode)).join(" | ")} |`),
    "",
    "Not tested:",
    "",
    ...exempt,
    "",
    "Packages without a row:",
    "",
    ...Object.entries(notPrimitives).map(([id, reason]) => `- \`${id}\`: ${reason}`),
  ].join("\n")
}
