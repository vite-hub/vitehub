import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { afterAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { formatReport, runCodemod, runMigration } from "../src/index.ts"
import { classify, resolveSpecifier } from "../src/t3-env/call-sites.ts"
import { envPathOf, planT3Env } from "../src/t3-env/plan.ts"

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
    "nuxt.config.ts": 'import "./env"\nexport default defineNuxtConfig({ vitehub: { host: "node" } })\n',
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
  it.each([
    ["modules/check-env.ts", "../env"],
    ["modules/check-env.server.ts", "../env"],
    ["modules/check-env/index.ts", "../../env"],
    ["layers/base/nuxt.config.ts", "../../env"],
    ["layers/base/modules/check-env.ts", "../../../env"],
    ["layers/base/layers/nested/modules/check-env.ts", "../../../../../env"],
  ])("keeps build-time env reads in %s", async (file, specifier) => {
    const source = `import { env } from "${specifier}"\nexport const databaseUrl = env.DATABASE_URL\n`
    const cwd = await app({ [file]: source })
    const run = await runCodemod("t3-env", { cwd })
    expect(await readFile(join(cwd, file), "utf8")).toBe(source)
    expect(await readFile(join(cwd, "env.ts"), "utf8")).toContain("createEnv")
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toHaveProperty("@t3-oss/env-nuxt")
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file }))
  })

  it.each([
    "server/api/modules/status.ts",
    "app/pages/modules/index.vue",
    "shared/modules/status.ts",
    "layers/base/server/api/modules/status.ts",
    "layers/base/app/pages/modules/index.vue",
  ])("migrates runtime reads in %s", async (file) => {
    const specifier = `${"../".repeat(file.split("/").length - 1)}env`
    const script = `import { env } from "${specifier}"\nexport const appUrl = env.NUXT_PUBLIC_APP_URL\n`
    const cwd = await app({ [file]: file.endsWith(".vue") ? `<script lang="ts">\n${script}</script>\n` : script })
    const run = await runCodemod("t3-env", { cwd })
    expect(await readFile(join(cwd, file), "utf8")).toContain("usePublicEnv().appUrl")
    await expect(readFile(join(cwd, "env.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(run.result.followUps.some(entry => entry.file === file)).toBe(false)
  })

  it.each(["optional()", "nullish()", 'default("fallback")'])("guards unsealing a secret with %s", async (wrapper) => {
    const file = "server/api/token.js"
    const cwd = await app({
      "env.ts": `import { createEnv } from "@t3-oss/env-nuxt"\nimport { z } from "zod"\nexport const env = createEnv({ server: { API_TOKEN: z.string().${wrapper} } })\n`,
      [file]: 'import { env } from "../../env"\nexport const token = env.API_TOKEN\n',
    })
    await runCodemod("t3-env", { cwd })
    const after = await readFile(join(cwd, file), "utf8")
    const expression = after.split("export const token = ")[1]!
    expect(runInNewContext(expression, { useServerEnv: () => ({ apiToken: undefined }) })).toBeUndefined()
    expect(runInNewContext(expression, { useServerEnv: () => ({ apiToken: { unseal: () => "token" } }) })).toBe("token")
  })

  it.each(["cjs", "cts"])("keeps the env module for require() in a %s file", async (extension) => {
    const file = `tools/check-env.${extension}`
    const source = 'const { env } = require("../env")\nconsole.log(env.DATABASE_URL)\n'
    const cwd = await app({ [file]: source })
    const run = await runCodemod("t3-env", { cwd })
    expect(await readFile(join(cwd, file), "utf8")).toBe(source)
    expect(await readFile(join(cwd, "env.ts"), "utf8")).toContain("createEnv")
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toHaveProperty("@t3-oss/env-nuxt")
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file }))
  })

  it.each([
    'import { env } from "./env"',
    'const { env } = await import("./env")',
    'const { env } = require("./env")',
  ])("keeps the env module when nuxt.config reads it through %s", async (statement) => {
    const file = "nuxt.config.ts"
    const cwd = await app({ [file]: `${statement}\nexport default defineNuxtConfig({ app: { baseURL: env.NUXT_PUBLIC_APP_URL }, vitehub: { host: "node" } })\n` })
    const run = await runCodemod("t3-env", { cwd })
    const after = await readFile(join(cwd, file), "utf8")
    expect(after).toContain(statement)
    expect(after).toContain("baseURL: env.NUXT_PUBLIC_APP_URL")
    expect(await readFile(join(cwd, "env.ts"), "utf8")).toContain("createEnv")
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies).toHaveProperty("@t3-oss/env-nuxt")
    expect(run.result.followUps).toContainEqual(expect.objectContaining({ file }))
  })

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
    expect(after).toContain('import { useServerEnv as viteHubServerEnv } from "vite-hub/env"')
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
    expect(classify("modules/check-env.ts")).toBe("outside")
    expect(classify("modules/check-env.server.ts")).toBe("outside")
    expect(classify("layers/base/nuxt.config.ts")).toBe("outside")
    expect(classify("layers/base/modules/check-env.ts")).toBe("outside")
    expect(classify("layers/base/modules/check-env/server/index.ts")).toBe("outside")
    expect(classify("layers/base/server/api/x.ts")).toBe("server")
    expect(classify("layers/base/app/pages/index.vue")).toBe("app")
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

describe("t3-env nullable schemas", () => {
  it.each([
    ["required", z.string().nullable(), true, undefined],
    ["optional", z.string().nullish(), false, undefined],
    ["defaulted", z.string().nullable().default("fallback"), false, "fallback"],
  ] as const)("preserves missing-value validation for a %s nullable field", async (_label, schema, required, defaultValue) => {
    const plan = await planT3Env({ exportName: "env", server: { VALUE: schema }, client: {}, shared: {}, otherOptions: [] }, fixtures)
    expect(plan.fields[0]?.field.required).toBe(required)
    expect(plan.fields[0]?.field.default).toBe(defaultValue)
    expect(plan.followUps).toContainEqual(expect.objectContaining({ key: "VALUE", message: expect.stringContaining("null") }))
  })
})

describe("t3-env parser compatibility", () => {
  it.each([
    ["ordinary string", z.string(), "value", "value"],
    ["coercing boolean", z.coerce.boolean(), "false", true],
    ["catch wrapper", z.string().min(3).catch("fallback"), "x", "fallback"],
    ["nested catch wrapper", z.string().min(3).catch("fallback").optional(), "x", "fallback"],
  ] as const)("reports unverified parser behavior for a %s", async (_label, schema, input, original) => {
    expect(schema.parse(input)).toBe(original)
    const plan = await planT3Env({ exportName: "env", server: { VALUE: schema }, client: {}, shared: {}, otherOptions: [] }, fixtures)
    expect(plan.followUps).toContainEqual(expect.objectContaining({ message: expect.stringContaining("Check every migrated variable") }))
    expect(plan.followUps).toContainEqual(expect.objectContaining({ message: expect.stringContaining('"false" as true') }))
    expect(plan.followUps).toContainEqual(expect.objectContaining({ message: expect.stringContaining("catch() fallbacks") }))
  })
})
