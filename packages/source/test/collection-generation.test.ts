import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { prepareSourceGeneration } from "../src/vite.ts"

it.each([
  "export const articles = other; const unrelated = defineCollection(load, { route: false })",
  "export const articles = other\nconst unrelated = defineCollection(load, { route: false })",
  "export const articles = other, unrelated = defineCollection(load, { route: false })",
  "const articles = other; export { articles }; const unrelated = defineCollection(load, { route: false })",
  "export const articles = other\ndefineCollection(load, { route: false })",
])("keeps unrelated later route metadata out of %s", async (source) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    await mkdir(join(projectRoot, "server/collections"), { recursive: true })
    await writeFile(join(projectRoot, "server/collections/articles.ts"), source)
    const handlers = await prepareSourceGeneration({ projectRoot })
    expect(handlers.map(handler => handler.route)).toEqual(["/api/articles"])
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

it.each([
  "export const articles = (() => { const value = 1; return defineCollection(load, { route: false }) })()",
  "const $articles = ((defineCollection(load, { route: false }))); export { $articles as articles }",
  "export { articles }; const articles: Collection<Row> = defineCollection(load, { route: false })",
  "export const articles =\n defineCollection(load, { route: false })",
])("preserves nested and indirect route opt-outs in %s", async (source) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-routes-"))
  try {
    await mkdir(join(projectRoot, "server/collections"), { recursive: true })
    await writeFile(join(projectRoot, "server/collections/articles.ts"), source)
    expect(await prepareSourceGeneration({ projectRoot })).toEqual([])
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})
