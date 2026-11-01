import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it } from "vitest"

import { parseProgram } from "../src/ast.ts"
import { rewriteCallSites } from "../src/nuxt-safe-runtime-config/call-sites.ts"
import { editNuxtConfig } from "../src/nuxt-safe-runtime-config/config-edit.ts"
import { readNuxtConfig, readRuntimeConfig } from "../src/nuxt-safe-runtime-config/nuxt-config.ts"
import { planFromJsonSchema } from "../src/nuxt-safe-runtime-config/schema.ts"

import type { EnvField } from "../src/nuxt-safe-runtime-config/fields.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function app(files: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-safety-"))
  directories.push(cwd)
  for (const [file, code] of Object.entries(files)) {
    await mkdir(join(cwd, file, ".."), { recursive: true })
    await writeFile(join(cwd, file), code)
  }
  return cwd
}

const publicField: EnvField = {
  section: "public",
  configPath: ["title"],
  envPath: ["title"],
  variable: "NUXT_PUBLIC_TITLE",
  kind: "string",
  required: true,
  secret: false,
}

async function rewrite(code: string) {
  const file = "composables/title.ts"
  const cwd = await app({ [file]: code })
  const result = await rewriteCallSites({ cwd, fields: [publicField], unmigrated: [] })
  expect(await readFile(join(cwd, file), "utf8")).toBe(code)
  return { ...result, code: result.edits[0]?.after ?? code }
}

describe("call-site bindings", () => {
  it.each([
    "import { useSafeRuntimeConfig } from './unrelated'",
    "import useSafeRuntimeConfig from './unrelated'",
    "import * as useSafeRuntimeConfig from './unrelated'",
    "import { unrelated as useSafeRuntimeConfig } from '#imports'",
    "const useSafeRuntimeConfig = () => ({ public: { title: 'local' } })",
    "function useSafeRuntimeConfig() { return { public: { title: 'local' } } }",
    "const { config: useSafeRuntimeConfig } = helpers",
  ])("preserves an unrelated binding: %s", async (binding) => {
    const code = `${binding}\nexport const title = useSafeRuntimeConfig().public.title\n`
    const result = await rewrite(code)
    expect(result.edits).toEqual([])
    expect(result.followUps[0]?.message).toContain("local binding or an unrelated import")
  })

  it.each([
    "export function title(useSafeRuntimeConfig) { return useSafeRuntimeConfig().public.title }",
    "export function title({ config: useSafeRuntimeConfig }) { return useSafeRuntimeConfig().public.title }",
    "try {} catch (useSafeRuntimeConfig) { console.log(useSafeRuntimeConfig().public.title) }",
    "export const object = { title(useSafeRuntimeConfig) { return useSafeRuntimeConfig().public.title } }",
    "import { useSafeRuntimeConfig } from '#imports'; export function title(useSafeRuntimeConfig) { return useSafeRuntimeConfig().public.title }",
  ])("declines shadowed calls: %s", async (code) => {
    const result = await rewrite(code)
    expect(result.edits).toEqual([])
    expect(result.remaining).toEqual(["composables/title.ts"])
  })

  it.each([
    "import Default, { useSafeRuntimeConfig, other as alias } from '#imports'",
    "import Default, { useSafeRuntimeConfig } from '#imports'",
    "import { other as alias, useSafeRuntimeConfig } from '#imports'",
  ])("preserves mixed import forms: %s", async (binding) => {
    const result = await rewrite(`${binding}\nexport const title = useSafeRuntimeConfig().public.title\n`)
    expect(result.code).toContain("usePublicEnv().title")
    expect(result.code).not.toContain("useSafeRuntimeConfig")
    const nuxtImport = parseProgram(result.code).program.body.find(node => node.type === "ImportDeclaration" && node.source.value === "#imports")
    if (nuxtImport?.type !== "ImportDeclaration") throw new Error("Expected the other Nuxt imports to remain")
    if (binding.includes("Default")) expect(nuxtImport.specifiers[0]?.type).toBe("ImportDefaultSpecifier")
    if (binding.includes("alias")) expect(nuxtImport.specifiers.at(-1)).toMatchObject({ type: "ImportSpecifier", local: { name: "alias" }, imported: { name: "other" } })
  })

  it("rewrites an aliased Nuxt import and preserves unrelated namespace imports", async () => {
    const result = await rewrite("import * as helpers from './helpers'\nimport { useSafeRuntimeConfig as safe } from '#imports'\nexport const title = safe().public.title\n")
    expect(result.code).toContain("import * as helpers from './helpers'")
    expect(result.code).toContain("usePublicEnv().title")
    expect(result.code).not.toContain("useSafeRuntimeConfig")
    expect(() => parseProgram(result.code)).not.toThrow()
  })

  it.each([
    "const usePublicEnv = () => 'unrelated'",
    "import usePublicEnv from './unrelated'",
    "import { other as usePublicEnv } from '#vitehub/env/public'",
    "import type { usePublicEnv } from '#vitehub/env/public'",
  ])("declines an accessor collision: %s", async (binding) => {
    const result = await rewrite(`${binding}\nexport const title = useSafeRuntimeConfig().public.title\n`)
    expect(result.edits).toEqual([])
    expect(result.followUps[0]?.message).toContain("aliased Env import")
  })

  it("declines an accessor shadowed by a parameter", async () => {
    const result = await rewrite("export function title(usePublicEnv) { return useSafeRuntimeConfig().public.title }")
    expect(result.edits).toEqual([])
  })

  it("reuses an existing Env import", async () => {
    const result = await rewrite("import { usePublicEnv } from '#vitehub/env/public'\nexport const title = useSafeRuntimeConfig().public.title\n")
    expect(result.code.match(/import \{ usePublicEnv \}/g)).toHaveLength(1)
    expect(result.code).toContain("usePublicEnv().title")
  })

  it("keeps imports used by calls it could not migrate or other references", async () => {
    const result = await rewrite("import { useSafeRuntimeConfig } from '#imports'\nexport const title = useSafeRuntimeConfig().public.title\nexport const getConfig = useSafeRuntimeConfig\n")
    expect(result.code).toContain("import { useSafeRuntimeConfig } from '#imports'")
    expect(result.code).toContain("usePublicEnv().title")
    expect(result.followUps[0]?.message).toContain("Some references")
  })

  it("declines Vue files whose script blocks can share bindings", async () => {
    const file = "components/Title.vue"
    const code = "<script>const usePublicEnv = () => 'local'</script>\n<script setup>const title = useSafeRuntimeConfig().public.title</script>"
    const cwd = await app({ [file]: code })
    const result = await rewriteCallSites({ cwd, fields: [publicField], unmigrated: [] })
    expect(result.edits).toEqual([])
    expect(result.followUps[0]?.message).toContain("multiple script blocks")
  })
})

describe("schema migration safety", () => {
  it.each(["string", "number", "boolean"])("leaves || fallbacks for %s in runtimeConfig for unset, empty and non-empty sources", async (type) => {
    const fallback = type === "string" ? "'fallback'" : type === "number" ? "7" : "true"
    const cwd = await app({ "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], runtimeConfig: { value: process.env.SOURCE || ${fallback} } })` })
    const config = await readNuxtConfig(cwd)
    const runtimeConfig = readRuntimeConfig(config).values
    const plan = planFromJsonSchema({ jsonSchema: { type: "object", properties: { value: { type } } }, issues: new Map(), runtimeConfig })
    expect(plan.fields).toEqual([])
    expect(plan.unmigrated).toEqual(["value"])
    expect(plan.followUps[0]?.message).toContain("empty-string fallback")
    const edited = editNuxtConfig({ config, env: { kind: "fields", fields: plan.fields }, migrated: new Set() })
    expect(edited.code).toContain(`value: process.env.SOURCE || ${fallback}`)
    // All three source states still execute the original expression after migration.
    for (const source of [undefined, "", type === "string" ? "configured" : type === "number" ? "2" : "false"]) {
      const original = config.code.match(/value: (.*?) \}/)?.[1]
      const migrated = edited.code.match(/value: (.*?) \}/)?.[1]
      const evaluate = (expression: string | undefined): unknown => runInNewContext(expression ?? "", { process: { env: { SOURCE: source } } })
      expect(evaluate(migrated)).toBe(evaluate(original))
    }
  })

  it("keeps nullish fallbacks eligible for conversion", async () => {
    const cwd = await app({ "nuxt.config.ts": "export default defineNuxtConfig({ runtimeConfig: { title: process.env.SOURCE ?? 'fallback' } })" })
    const plan = planFromJsonSchema({
      jsonSchema: { type: "object", properties: { title: { type: "string" } } },
      issues: new Map(),
      runtimeConfig: readRuntimeConfig(await readNuxtConfig(cwd)).values,
    })
    expect(plan.fields[0]).toMatchObject({ default: "fallback", extraVariables: ["SOURCE"] })
    expect(plan.unmigrated).toEqual([])
  })

  it("leaves every colliding public path and its reads for manual migration", async () => {
    const code = "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], runtimeConfig: { public: { fooBar: 'first', foo: { bar: 'second' }, title: 'site' } } })"
    const file = "composables/title.ts"
    const source = "export const first = useSafeRuntimeConfig().public.fooBar\nexport const second = useSafeRuntimeConfig().public.foo.bar\nexport const title = useSafeRuntimeConfig().public.title\n"
    const cwd = await app({ "nuxt.config.ts": code, [file]: source })
    const config = await readNuxtConfig(cwd)
    const plan = planFromJsonSchema({
      jsonSchema: { type: "object", properties: { public: { type: "object", properties: { fooBar: { type: "string" }, foo: { type: "object", properties: { bar: { type: "string" } } }, title: { type: "string" } } } } },
      issues: new Map(),
      runtimeConfig: readRuntimeConfig(config).values,
    })
    expect(plan.fields.map(field => field.envPath)).toEqual([["title"]])
    expect(plan.unmigrated.sort()).toEqual(["public.foo.bar", "public.fooBar"])
    expect(plan.followUps.filter(entry => entry.message.includes("collides"))).toHaveLength(2)
    const edited = editNuxtConfig({ config, env: { kind: "fields", fields: plan.fields }, migrated: new Set(["public.title"]) })
    const root = parseProgram(edited.code).program.body.find(node => node.type === "ExportDefaultDeclaration")
    expect(root?.type).toBe("ExportDefaultDeclaration")
    expect(edited.code).toContain("fooBar: 'first'")
    expect(edited.code).toContain("foo: { bar: 'second' }")
    const calls = await rewriteCallSites({ cwd, fields: plan.fields, unmigrated: plan.unmigrated })
    expect(calls.edits[0]?.after).toContain("useSafeRuntimeConfig().public.fooBar")
    expect(calls.edits[0]?.after).toContain("useSafeRuntimeConfig().public.foo.bar")
    expect(calls.edits[0]?.after).toContain("usePublicEnv().title")
  })
})
