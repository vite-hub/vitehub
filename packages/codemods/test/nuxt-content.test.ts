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
})
