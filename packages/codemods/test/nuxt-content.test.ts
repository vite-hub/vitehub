import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod } from "../src/index.ts"
import { withVersionPlaceholder } from "./fixture-version.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/nuxt-content-test/", import.meta.url))

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

describe("nuxt-content", () => {
  it("moves the collections of content.config.ts to Content Sources", async () => {
    const input = join(fixtures, "nuxt-content", "input")
    const run = await runCodemod("nuxt-content", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      if (edit.after !== null) await expect(withVersionPlaceholder(edit.after)).toMatchFileSnapshot(join(fixtures, "nuxt-content", "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "nuxt-content", "output", "report.txt"))
  })

  it("leaves a Docus site to the docus codemod", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ extends: ['docus'], modules: ['@nuxt/content'] })\n",
      "content.config.ts": "export default defineContentConfig({ collections: {} })\n",
      "content/index.md": "---\ntitle: Home\n---\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toEqual(["docus"])
  })

  it("stops without edits when a collection source is computed", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxt/content'] })\n",
      "content.config.ts": "import { defineCollection, defineContentConfig } from '@nuxt/content'\nexport default defineContentConfig({ collections: { docs: defineCollection({ type: 'page', source: sources() }) } })\n",
    })
    await expect(runCodemod("nuxt-content", { cwd, dryRun: true })).rejects.toThrow("No collection of content.config.ts could be moved")
  })

  it.each([
    ["{ include: 'blog/**/*.md', prefix: '/posts', exclude: ['**/drafts/**'] }", "", /exclude cannot be safely rebased/],
    ["{ include: 'blog/post-*.md', prefix: '/posts' }", "", /prefix .* cannot be preserved/],
    ["'blog/*.md'", ", schema: article", /schema references article/],
    ["'blog/*.md'", ", schema: z.object({ title: z.string().editor({}) })", /\.editor\(\) schema helper/],
  ])("leaves all collections intact when one cannot migrate: %s%s", async (source, schema, message) => {
    const config = "export default defineNuxtConfig({ modules: ['@nuxt/content'] })\n"
    const content = `import { defineCollection, defineContentConfig, z } from '@nuxt/content'\nconst article = z.object({ title: z.string() })\nexport default defineContentConfig({ collections: { home: defineCollection({ type: 'page', source: 'about.md' }), blog: defineCollection({ type: 'page', source: ${source}${schema} }) } })\n`
    const cwd = await createApp({ "nuxt.config.ts": config, "content.config.ts": content, "content/blog/drafts/private.md": "# Private\n" })
    await expect(runCodemod("nuxt-content", { cwd })).rejects.toThrow(message)
    expect(await readFile(join(cwd, "content.config.ts"), "utf8")).toBe(content)
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    await expect(readFile(join(cwd, "server/content.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves a literal filename with a prefix and a Zod alias", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxt/content'] })\n",
      "content.config.ts": "import { defineCollection, defineContentConfig, z as schema } from '@nuxt/content'\nexport default defineContentConfig({ collections: { home: defineCollection({ type: 'page', source: { include: 'about.md', prefix: '/company' }, schema: schema.object({ title: schema.string() }) }) } })\n",
      "content/about.md": "# About\n",
    })
    await runCodemod("nuxt-content", { cwd })
    const output = await readFile(join(cwd, "server/content.ts"), "utf8")
    expect(output).toContain("import { z as schema } from 'zod'")
    expect(output).toContain("glob({ cwd: 'content', include: 'about.md', prefix: 'company', ignore:")
  })

  it("does not uninstall a Content module referenced by an import", async () => {
    const config = "import contentModule from '@nuxt/content'\nexport default defineNuxtConfig({ modules: [contentModule] })\n"
    const cwd = await createApp({
      "nuxt.config.ts": config,
      "content.config.ts": "import { defineCollection, defineContentConfig } from '@nuxt/content'\nexport default defineContentConfig({ collections: { home: defineCollection({ type: 'page', source: 'about.md' }) } })\n",
    })
    await expect(runCodemod("nuxt-content", { cwd })).rejects.toThrow("remaining @nuxt/content reference")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
  })

  it("keeps Nuxt Content's editor backup exclusions after moving the source base", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxt/content'] })\n",
      "content.config.ts": "import { defineCollection, defineContentConfig } from '@nuxt/content'\nexport default defineContentConfig({ collections: { posts: defineCollection({ type: 'page', source: { include: 'blog/**/*.md', prefix: '/posts' } }) } })\n",
      "content/blog/intro.md": "# Intro\n",
      "content/blog/~intro.md": "# Unpublished backup\n",
    })
    await runCodemod("nuxt-content", { cwd })
    const output = await readFile(join(cwd, "server/content.ts"), "utf8")
    expect(output).toContain("'**/~*'")
  })
})
