import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod, runMigration } from "../src/index.ts"
import { classify, resolveSpecifier } from "../src/t3-env/call-sites.ts"
import { envPathOf } from "../src/t3-env/plan.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/t3-env-test/", import.meta.url))

async function app(files: Record<string, string>): Promise<string> {
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "app-"))
  const sources = {
    "env.ts": `import { createEnv } from "@t3-oss/env-nuxt"
import { z } from "zod"
export const env = createEnv({
  server: { DATABASE_URL: z.string() },
  client: { NUXT_PUBLIC_APP_URL: z.string() },
})
`,
    "nuxt.config.ts": 'import "./env"\nexport default defineNuxtConfig({ vitehub: { preset: "node" } })\n',
    "package.json": JSON.stringify({ dependencies: { "@t3-oss/env-nuxt": "^0.13.0" } }),
    ...files,
  }
  for (const [path, source] of Object.entries(sources)) {
    await mkdir(join(directory, path, ".."), { recursive: true })
    await writeFile(join(directory, path), source)
  }
  return directory
}

afterAll(() => rm(scratch, { recursive: true, force: true }))

describe("t3-env import safety", () => {
  it.each(["ts", "tsx", "jsx"])("keeps the env module for a dynamic import in a %s file", async (extension) => {
    const file = `app/components/Env.${extension}`
    const source = 'export const loadEnv = () => import("~~/env")\n'
    const cwd = await app({ [file]: source })
    const run = await runCodemod("t3-env", { cwd })
    expect(await readFile(join(cwd, "env.ts"), "utf8")).toContain("createEnv")
    expect(await readFile(join(cwd, file), "utf8")).toBe(source)
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toHaveProperty("@t3-oss/env-nuxt")
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file }))
  })

  it("keeps reads of a shadowed env binding unchanged", async () => {
    const file = "server/utils/db.ts"
    const source = 'import { env } from "../../env"\nexport const readUrl = (env: { DATABASE_URL: string }) => env.DATABASE_URL\nexport const databaseUrl = env.DATABASE_URL\n'
    const cwd = await app({ [file]: source })
    const run = await runCodemod("t3-env", { cwd })
    expect(await readFile(join(cwd, file), "utf8")).toBe(source)
    expect(await readFile(join(cwd, "env.ts"), "utf8")).toContain("createEnv")
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file, message: expect.stringContaining("binding") }))
  })

  it("uses an alias when an Env accessor name already has a binding", async () => {
    const file = "server/utils/db.ts"
    const cwd = await app({ [file]: 'import { env } from "../../env"\nconst useServerEnv = () => "existing"\nexport const existing = useServerEnv()\nexport const databaseUrl = env.DATABASE_URL\n' })
    await runCodemod("t3-env", { cwd })
    const after = await readFile(join(cwd, file), "utf8")
    expect(after).toContain('import { useServerEnv as viteHubServerEnv } from "#vitehub/env/server"')
    expect(after).toContain('const useServerEnv = () => "existing"')
    expect(after).toContain("export const databaseUrl = viteHubServerEnv().databaseUrl.unseal()")
  })

  it("keeps bracket reads in a Vue template", async () => {
    const file = "app/components/Env.vue"
    const source = '<script setup lang="ts">\nimport { env } from "../../env"\n</script>\n<template>{{ env["NUXT_PUBLIC_APP_URL"] }}</template>\n'
    const cwd = await app({ [file]: source })
    const run = await runCodemod("t3-env", { cwd })
    expect(await readFile(join(cwd, file), "utf8")).toBe(source)
    expect(await readFile(join(cwd, "env.ts"), "utf8")).toContain("createEnv")
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file, message: expect.stringContaining("template") }))
  })

  it("deletes the module and dependency after migrating every importer", async () => {
    const file = "server/utils/db.ts"
    const cwd = await app({ [file]: 'import { env } from "../../env"\nexport const databaseUrl = env.DATABASE_URL\n' })
    const migration = await runMigration({ cwd })
    expect(migration.edits).toContainEqual(expect.objectContaining({ path: "env.ts", after: null }))
    await expect(readFile(join(cwd, "env.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).not.toHaveProperty("@t3-oss/env-nuxt")
    expect(await readFile(join(cwd, file), "utf8")).toContain("useServerEnv().databaseUrl.unseal()")
  })
})

describe.each([
  ["t3-env", "an env module that only Nuxt code imports"],
  ["t3-env-outside", "an env module that a config outside Nuxt also imports"],
])("t3-env with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("t3-env", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after ?? "(deleted)\n").toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe("t3-env helpers", () => {
  it("names Env fields after the variable without its Nuxt prefix", () => {
    expect(envPathOf("DATABASE_URL", "server")).toBe("databaseUrl")
    expect(envPathOf("NUXT_SESSION_PASSWORD", "server")).toBe("sessionPassword")
    expect(envPathOf("NUXT_PUBLIC_APP_URL", "public")).toBe("appUrl")
  })

  it("classifies files by where Nuxt runs them", () => {
    expect(classify("server/api/x.ts")).toBe("server")
    expect(classify("plugins/auth.server.ts")).toBe("server")
    expect(classify("app/pages/index.vue")).toBe("app")
    expect(classify("components/Card.vue")).toBe("app")
    expect(classify("shared/utils.ts")).toBe("shared")
    expect(classify("db/index.ts")).toBe("shared")
    expect(classify("drizzle.config.ts")).toBe("outside")
    expect(classify("scripts/seed.ts")).toBe("outside")
  })

  it("resolves ~ and @ to both source directory candidates", () => {
    const cwd = join(fixtures, "t3-env/input")
    expect(resolveSpecifier(cwd, "server/a.ts", "@/server/env")).toEqual(["app/server/env", "server/env"])
    expect(resolveSpecifier(cwd, "server/a.ts", "~~/env.ts")).toEqual(["env"])
    expect(resolveSpecifier(cwd, "server/api/a.ts", "../../env")).toEqual(["env"])
    expect(resolveSpecifier(cwd, "server/a.ts", "#shared/env")).toEqual(["shared/env"])
    expect(resolveSpecifier(cwd, "server/a.ts", "zod")).toEqual([])
  })
})
