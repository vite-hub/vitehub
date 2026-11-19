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
  it.each([
    [{ "content/docs/intro.md": "# Intro\n", "content/notes.md": "# Private\n" }, /notes\.md.*outside the original/],
    [{ "content.config.ts": "export default {}\n" }, /custom Docus collections/],
    [{ "content/Getting Started.md": "# Intro\n" }, /existing Docus URL slug/],
    [{ "content/index.md": "# Home\n[Setup](./1.setup.md)\n", "content/1.setup.md": "# Setup\n" }, /local Markdown file links/],
    [{ "content/index.md": "---\nseo: [\n---\n" }, /Expected a YAML mapping/],
    [{ "app.config.ts": "const description = 'Example'; export default defineAppConfig({ seo: { description } })\n" }, /computed seo.description/],
  ])("stops before unsafe edits (%j)", async (files, message) => {
    const config = "export default defineNuxtConfig({ extends: ['docus'] })\n"
    const cwd = await createApp({ "content/index.md": "# Home\n", "nuxt.config.ts": config, ...files })
    await expect(runCodemod("docus", { cwd })).rejects.toThrow(message)
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    for (const [file, before] of Object.entries(files)) expect(await readFile(join(cwd, file), "utf8")).toBe(before)
  })

  it("replaces a direct Content module and keeps valid app config syntax", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ extends: ['docus'], modules: ['@nuxt/content'] })\n",
      "app.config.ts": "export default defineAppConfig({ ui: {}, seo: { title: 'Example' } , })\n",
      "content/index.md": "# Home\n",
    })
    await runCodemod("docus", { cwd })
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toContain("modules: ['@vite-hub/docs/nuxt']")
    expect(await readFile(join(cwd, "app.config.ts"), "utf8")).toBe("export default defineAppConfig({ ui: {}, })\n")
  })

  it("stops before dropping a computed site URL", async () => {
    const config = "export default defineNuxtConfig({ extends: ['docus'], site: { name: 'Docs', url: process.env.DOCS_URL } })\n"
    const cwd = await createApp({ "nuxt.config.ts": config, "content/index.md": "# Home\n" })
    await expect(runCodemod("docus", { cwd })).rejects.toThrow("computed site.url")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
  })

  it("keeps unmapped settings in the original config", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ extends: ['docus'], llms: { domain: 'https://docs.example', description: 'Help' } })\n",
      "app.config.ts": "export default defineAppConfig({ github: { url: 'https://github.com/org/project', edit: false } })\n",
      "content/index.md": "# Home\n",
    })
    const run = await runCodemod("docus", { cwd })
    const config = await readFile(join(cwd, "nuxt.config.ts"), "utf8")
    expect(config).toContain("description: 'Help'")
    expect(config).toContain("url: 'https://docs.example'")
    expect(config).toContain("github: { repo: 'org/project' }")
    expect(await readFile(join(cwd, "app.config.ts"), "utf8")).toContain("edit: false")
    expect(formatReport(run)).toContain("github.edit")
  })

  it("keeps other statements when all app settings migrated", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ extends: ['docus'] })\n",
      "app.config.ts": "import './setup'\nexport default defineAppConfig({ seo: { title: 'Example' } })\n",
      "content/index.md": "# Home\n",
    })
    await runCodemod("docus", { cwd })
    expect(await readFile(join(cwd, "app.config.ts"), "utf8")).toBe("import './setup'\nexport default defineAppConfig({  })\n")
  })

  it("leaves headings, blocks and links in fenced examples untouched", () => {
    const example = "~~~~md\n# Example heading\n::callout\n::u-page-hero\n[Setup](./1.setup.md)\n~~~~\n"
    const { code, followUps } = movePage("content/index.md", `${example}\n# Actual title\n\n::callout\nNote.\n::\n`, undefined)
    expect(code).toContain(example)
    expect(code).toContain("title: Actual title")
    expect(code).toContain("::note\nNote.")
    expect(followUps).toEqual([])
  })

  it.each([
    ["content/guide.md", "content/1.guide.md"],
    ["content/guide.md/keep.txt", "content/1.guide.md"],
    ["content/guide/.navigation.yml", "content/1.guide/intro.md"],
    ["content/guide", "content/1.guide/intro.md"],
  ])("leaves both files alone when %s blocks a move", async (occupied, source) => {
    const config = "export default defineNuxtConfig({ extends: ['docus'] })\n"
    const cwd = await createApp({ "nuxt.config.ts": config, [occupied]: "title: Keep\n", [source]: "# Original\n" })
    await expect(runCodemod("docus", { cwd })).rejects.toThrow(/occupied|same destination/)
    expect(await readFile(join(cwd, occupied), "utf8")).toBe("title: Keep\n")
    expect(await readFile(join(cwd, source), "utf8")).toBe("# Original\n")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
  })

  it("reads the order prefix of Nuxt Content", () => {
    expect(stripOrder("2.installation")).toEqual({ name: "installation", order: 2 })
    expect(stripOrder("index")).toEqual({ name: "index" })
    expect(stripOrder("v1.2")).toEqual({ name: "v1.2" })
    expect(stripOrder("1.2")).toEqual({ name: "1.2" })
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
