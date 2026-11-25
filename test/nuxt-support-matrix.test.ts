import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, it } from "vitest"

import { renderNuxtSupportMatrix } from "./consumer/nuxt-primitives/index.ts"

const pagePath = join(import.meta.dirname, "../docs/content/docs/frameworks-hosts/support-matrix.md")
const marked = /(<!-- support-matrix:nuxt:start -->\n)([\s\S]*?)(\n<!-- support-matrix:nuxt:end -->)/

it("documents the Nuxt rows and exemptions of the packed-app test on the support matrix page", async () => {
  let page = await readFile(pagePath, "utf8")
  if (process.env.VITEHUB_UPDATE_SUPPORT_MATRIX === "1") {
    page = page.replace(marked, (_match, start: string, _table: string, end: string) => `${start}${renderNuxtSupportMatrix()}${end}`)
    await writeFile(pagePath, page)
  }
  expect(marked.exec(page)?.[2], "Run this test with VITEHUB_UPDATE_SUPPORT_MATRIX=1 to write the table.").toBe(renderNuxtSupportMatrix())
})
