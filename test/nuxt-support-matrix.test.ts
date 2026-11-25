import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, it } from "vitest"

import { nuxtSupport } from "./consumer/nuxt-primitives.test.ts"
import { modes, type Mode } from "./consumer/nuxt-primitives/row.ts"

const pagePath = join(import.meta.dirname, "../docs/content/docs/frameworks-hosts/support-matrix.md")
const marked = /(<!-- support-matrix:nuxt:start -->\n)([\s\S]*?)(\n<!-- support-matrix:nuxt:end -->)/

const modeNames: Record<Mode, string> = {
  "node-build": "Node build",
  "node-dev": "Node dev",
  "cloudflare-build": "Cloudflare build",
  "cloudflare-dev": "Cloudflare dev",
}

function renderNuxtSupportMatrix(): string {
  const { rows, notPrimitives } = nuxtSupport
  const tableRow = (id: string, cells: string[]) => `| \`${id}\` | ${cells.join(" | ")} |`
  const exempt = rows.flatMap(row => modes.flatMap(mode => row.exempt?.[mode] ? [`- \`${row.id}\`, ${modeNames[mode]}: ${row.exempt[mode]}`] : []))
  return [
    `| Package | ${modes.map(mode => modeNames[mode]).join(" | ")} |`,
    `| --- |${modes.map(() => " --- |").join("")}`,
    ...rows.map(row => tableRow(row.id, modes.map(mode => row.exempt?.[mode] ? "Not tested" : "Tested"))),
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

it("documents the Nuxt rows and exemptions of the packed-app test on the support matrix page", async () => {
  let page = await readFile(pagePath, "utf8")
  if (process.env.VITEHUB_UPDATE_SUPPORT_MATRIX === "1") {
    page = page.replace(marked, (_match, start: string, _table: string, end: string) => `${start}${renderNuxtSupportMatrix()}${end}`)
    await writeFile(pagePath, page)
  }
  expect(marked.exec(page)?.[2], "Run this test with VITEHUB_UPDATE_SUPPORT_MATRIX=1 to write the table.").toBe(renderNuxtSupportMatrix())
})
