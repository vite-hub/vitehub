import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { codemodsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { isCodemodError, runCodemod } from "../src/index.ts"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

it("gives each codemods code a fix and its own docs page", () => {
  for (const error of [codemodsErrorDiagnostics.CODEMODS_BLOCKED({ problem: "p" }), codemodsErrorDiagnostics.CODEMODS_UNKNOWN({ available: ["a"], name: "b" })]) {
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/codemods/diagnostics/${error.code.toLowerCase()}`)
  }
})

it("rejects an unknown codemod with CODEMODS_UNKNOWN and the names", async () => {
  const error = await runCodemod("nope").catch((caught: unknown) => caught)
  expect(isCodemodError(error)).toBe(true)
  expect(error).toMatchObject({ code: "CODEMODS_UNKNOWN", fix: expect.stringContaining("codemod names"), message: expect.stringContaining("Unknown codemod \"nope\"") })
})

it("rejects a package.json that is not an object with CODEMODS_BLOCKED and a fix", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemods-"))
  dirs.push(cwd)
  await writeFile(join(cwd, "package.json"), "[]")
  await writeFile(join(cwd, "nuxt.config.ts"), "export default defineNuxtConfig({ modules: [\"nuxt-cron\"] })\n")
  const error = await runCodemod("nuxt-cron", { cwd, dryRun: true }).catch((caught: unknown) => caught)
  expect(error).toMatchObject({ code: "CODEMODS_BLOCKED", fix: expect.stringContaining("run the codemod again") })
})
