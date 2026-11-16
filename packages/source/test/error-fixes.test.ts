import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { sourceErrorDiagnostics } from "../src/error-diagnostics.ts"
import { mergeGeneratedSourceNitroConfig, prepareSourceGeneration } from "../src/vite.ts"

const fixedCodes = [
  "SOURCE_B0001",
  "SOURCE_B0002",
  "SOURCE_B0003",
  "SOURCE_B0004",
  "SOURCE_B0005",
  "SOURCE_B0006",
  "SOURCE_B0007",
  "SOURCE_B0008",
] as const

async function generate(files: Record<string, string>) {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-error-fixes-"))
  try {
    for (const [file, source] of Object.entries(files)) {
      await mkdir(join(projectRoot, file, ".."), { recursive: true })
      await writeFile(join(projectRoot, file), source)
    }
    return await prepareSourceGeneration({ projectRoot })
  }
  finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
}

it("gives each Source build code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = sourceErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/source/diagnostics/${code.toLowerCase()}`)
  }
})

it("names the Collection file rule when a filename is not an identifier", async () => {
  await expect(generate({ "server/collections/blog-posts.ts": "export const posts = defineCollection(load)" })).rejects.toMatchObject({
    code: "SOURCE_B0003",
    fix: expect.stringContaining("valid JavaScript identifier"),
  })
})

it("names the export when a Collection file exports another name", async () => {
  await expect(generate({ "server/collections/articles.ts": "export const posts = defineCollection(load)" })).rejects.toMatchObject({
    code: "SOURCE_B0004",
    fix: expect.stringContaining("defineCollection"),
  })
})

it("names the default export when server/content.ts has none", async () => {
  await expect(generate({ "server/content.ts": "export const other = 1" })).rejects.toMatchObject({
    code: "SOURCE_B0008",
    fix: expect.stringContaining("export default defineContent"),
  })
})

it("names the Nitro handlers config when a generated route is taken", () => {
  expect(() => mergeGeneratedSourceNitroConfig(
    { handlers: [{ handler: "server/my-articles.ts", method: "get", route: "/api/articles" }] },
    [{ handler: "/app/.vitehub/source/routes/articles.mjs", method: "get", route: "/api/articles" }],
  )).toThrow(expect.objectContaining({
    code: "SOURCE_B0002",
    fix: expect.stringContaining("`handlers`"),
  }))
})
