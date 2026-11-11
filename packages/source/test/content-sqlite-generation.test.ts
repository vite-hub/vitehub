import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it } from "vitest"

import { prepareSourceGeneration } from "../src/vite.ts"

let projectRoot: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "source-content-sqlite-"))
  await mkdir(join(projectRoot, "server"), { recursive: true })
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

const contentFile = (imports: string) => [
  imports,
  "import { defineContent } from 'vite-hub/content'",
  "export default defineContent({ sources: {} })",
].join("\n")

it.each([
  ["vite-hub/content/sqlite", undefined, "@vite-hub/content/sqlite"],
  ["@vite-hub/content/sqlite", undefined, "@vite-hub/content/sqlite"],
  ["vite-hub/content/sqlite", "vite-hub/content", "vite-hub/content/sqlite"],
])("loads SQLite at server start when server/content.ts imports %s (base %s)", async (specifier, contentImportBase, loaded) => {
  await writeFile(join(projectRoot, "server/content.ts"), contentFile(`import { sqlite } from '${specifier}'`))
  const handlers = await prepareSourceGeneration({ projectRoot, ...(contentImportBase ? { contentImportBase } : {}) })
  const plugin = join(projectRoot, ".vitehub/content/sqlite.mjs")
  expect(handlers).toContainEqual({ handler: plugin, plugin: true })
  expect(handlers).toContainEqual({ handler: join(projectRoot, ".vitehub/content/types.mjs"), plugin: true })
  expect(await readFile(join(projectRoot, ".vitehub/types/content.d.ts"), "utf8")).toBe("export {}\n")
  expect(await readFile(plugin, "utf8")).toContain(`import { sqlite } from ${JSON.stringify(loaded)}\n`)
  expect(await readFile(plugin, "utf8")).toContain("export default () => sqlite\n")
})

it("adds no SQLite plugin without the import, and removes a stale one", async () => {
  await writeFile(join(projectRoot, "server/content.ts"), contentFile("import { sqlite } from 'vite-hub/content/sqlite'"))
  await prepareSourceGeneration({ projectRoot })
  await writeFile(join(projectRoot, "server/content.ts"), contentFile("import sqlite from 'comark-content/database/sqlite-node'"))
  const handlers = await prepareSourceGeneration({ projectRoot })
  expect(handlers.some(handler => handler.handler.endsWith("sqlite.mjs"))).toBe(false)
  await expect(readFile(join(projectRoot, ".vitehub/content/sqlite.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("removes SQLite and Content types artifacts when the Content entry is removed", async () => {
  const entry = join(projectRoot, "server/content.ts")
  await writeFile(entry, contentFile("import { sqlite } from 'vite-hub/content/sqlite'"))
  await prepareSourceGeneration({ projectRoot })
  await rm(entry)

  expect(await prepareSourceGeneration({ projectRoot })).toEqual([])
  for (const path of [".vitehub/content/sqlite.mjs", ".vitehub/content/types.mjs", ".vitehub/types/content.d.ts"]) {
    await expect(readFile(join(projectRoot, path), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  }
})
