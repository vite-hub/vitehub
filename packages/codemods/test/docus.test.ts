import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { movePage, moveSection, stripOrder } from "../src/docus/content.ts"
import { withVersionPlaceholder } from "./fixture-version.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/docus-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function createApp(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [file, code] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, file)), { recursive: true })
    await writeFile(join(cwd, file), code)
  }
  return cwd
}

describe("docus", () => {
  it("moves a Docus site to @vite-hub/docs", async () => {
    const input = join(fixtures, "docus", "input")
    const run = await runCodemod("docus", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      if (edit.after !== null) await expect(withVersionPlaceholder(edit.after)).toMatchFileSnapshot(join(fixtures, "docus", "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "docus", "output", "report.txt"))
  })

  it("adds the module to an existing modules list and keeps other layers", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({\n  extends: ['docus', './theme'],\n  modules: ['@nuxt/image'],\n})\n",
      "content/index.md": "---\ntitle: Home\n---\n\nHello.\n",
    })
    const run = await runCodemod("docus", { cwd, dryRun: true })
    expect(run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after).toBe([
      "export default defineNuxtConfig({",
      "  extends: ['./theme'],",
      "  modules: ['@nuxt/image', '@vite-hub/docs/nuxt'],",
      "  docs: {",
      "    site: { name: 'Docs' },",
      "  },",
      "})",
      "",
    ].join("\n"))
  })

  it("stops without edits when the app does not extend docus", async () => {
    const cwd = await createApp({ "nuxt.config.ts": "export default defineNuxtConfig({})\n", "package.json": "{\"dependencies\":{\"docus\":\"^5.0.0\"}}\n" })
    await expect(runCodemod("docus", { cwd, dryRun: true })).rejects.toThrow("does not extend the docus layer")
  })
})

describe("docus content", () => {
  it("reads the order prefix of Nuxt Content", () => {
    expect(stripOrder("2.installation")).toEqual({ name: "installation", order: 2 })
    expect(stripOrder("index")).toEqual({ name: "index" })
    expect(stripOrder("v1.2")).toEqual({ name: "v1.2" })
  })

  it("keeps a page that already has the docs fields", () => {
    const code = "---\ntitle: Usage\nnavigation.order: 3\n---\n\nText.\n"
    expect(movePage("content/usage.md", code, 1)).toEqual({ code, followUps: [] })
  })

  it("writes the folder order into .navigation.yml", () => {
    expect(moveSection("content/1.guide/.navigation.yml", "title: Guide\nicon: i-lucide-book\nbadge: new\n", 1)).toEqual({
      code: "title: Guide\nicon: i-lucide-book\norder: 1\n",
      followUps: [{ file: "content/1.guide/.navigation.yml", message: "The codemod dropped badge, which @vite-hub/docs does not read in .navigation.yml." }],
    })
  })
})
