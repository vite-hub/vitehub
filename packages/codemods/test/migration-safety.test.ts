import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { runInNewContext } from "node:vm"

import { env, resolveServerEnv, SecretEnv } from "@vite-hub/env"
import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { end, parseProgram, start } from "@vite-hub/internal/ast"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runCodemod } from "../src/index.ts"
import { rewriteCallSites } from "../src/nuxt-safe-runtime-config/call-sites.ts"
import { editNuxtConfig } from "../src/nuxt-safe-runtime-config/config-edit.ts"
import { readRuntimeConfig } from "../src/nuxt-safe-runtime-config/nuxt-config.ts"
import { readNuxtConfig } from "../src/shared/nuxt-config.ts"
import { planFromJsonSchema, schemaIssues, schemaToJsonSchema } from "../src/nuxt-safe-runtime-config/schema.ts"

import type { EnvRuntimeConfigOptions } from "@vite-hub/env"
import type { EnumLike } from "zod/v3"
import type { EnvField } from "../src/nuxt-safe-runtime-config/fields.ts"

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
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

async function rewrite(code: string, file = "composables/title.ts") {
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

  it.each([
    ["components/Title.tsx", "<SafeConfig />"],
    ["components/Title.jsx", "<SafeConfig.Part />"],
    ["components/Title.vue", "<SafeConfig></SafeConfig>"],
  ])("keeps a composable alias referenced in JSX in %s", async (file, element) => {
    const script = `import { useSafeRuntimeConfig as SafeConfig } from '#imports'\nexport const title = SafeConfig().public.title\nexport const view = ${element}\n`
    const code = file.endsWith(".vue") ? `<script setup lang="tsx">\n${script}</script>` : script
    const result = await rewrite(code, file)
    expect(result.code).toContain("import { useSafeRuntimeConfig as SafeConfig } from '#imports'")
    expect(result.code).toContain("usePublicEnv().title")
    expect(result.code).toContain(element)
    expect(result.followUps[0]?.message).toContain("Some references to SafeConfig remain")
    expect(result.remaining).toEqual([file])
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

describe("nested app boundaries", () => {
  it.each([false, true])("reports an external local layer (transitive: %s) without changing it", async (transitive) => {
    const code = "export default defineEventHandler(event => useSafeRuntimeConfig(event).apiKey)\n"
    const layerConfig = "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })\n"
    const layerPackage = '{"dependencies":{"nuxt-safe-runtime-config":"0.3.2"}}\n'
    const root = await app({
      "app/nuxt.config.ts": `export default defineNuxtConfig({ extends: ['${transitive ? "./layers/base" : "../layers/accounts"}'], modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { envSchema: '.env.example' } })`,
      "app/.env.example": "NUXT_API_KEY=secret\n",
      "app/package.json": layerPackage,
      ...(transitive ? { "app/layers/base/nuxt.config.ts": "export default defineNuxtConfig({ extends: ['../../../layers/accounts'] })" } : {}),
      "layers/accounts/nuxt.config.ts": layerConfig,
      "layers/accounts/package.json": layerPackage,
      "layers/accounts/server/api/key.get.ts": code,
    })
    const { result } = await runCodemod("nuxt-safe-runtime-config", { cwd: join(root, "app") })
    expect(await readFile(join(root, "layers/accounts/server/api/key.get.ts"), "utf8")).toBe(code)
    expect(await readFile(join(root, "layers/accounts/nuxt.config.ts"), "utf8")).toBe(layerConfig)
    expect(await readFile(join(root, "layers/accounts/package.json"), "utf8")).toBe(layerPackage)
    expect(result.edits.every(edit => !edit.path.startsWith("../"))).toBe(true)
    expect(result.followUps).toContainEqual(expect.objectContaining({
      file: "../layers/accounts",
      message: expect.stringMatching(/outside the app directory.*useSafeRuntimeConfig\(\).*module options/),
    }))
  })

  it.each([
    ["apps/child/nuxt.config.ts", "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })"],
    ["services/api/nitro.config.ts", "export default defineNitroConfig({ modules: ['nuxt-safe-runtime-config/nitro'] })"],
    ["themes/unused/nuxt.config.ts", "export default defineNuxtConfig({ safeRuntimeConfig: {} })"],
    ["apps/plain/nuxt.config.ts", "export default defineNuxtConfig({})"],
  ])("leaves the source tree owned by %s unchanged", async (configFile, config) => {
    const directory = posix.dirname(configFile)
    const nestedFile = `${directory}/composables/title.ts`
    const siblingFile = `${directory}-sibling/composables/title.ts`
    const code = "export const title = useSafeRuntimeConfig().public.title\n"
    const nestedPackage = '{"dependencies":{"nuxt-safe-runtime-config":"0.3.2"}}\n'
    const cwd = await app({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { envSchema: '.env.example' } })",
      ".env.example": "NUXT_PUBLIC_TITLE=site\n",
      "package.json": nestedPackage,
      "composables/title.ts": code,
      [configFile]: config,
      [`${directory}/package.json`]: nestedPackage,
      [nestedFile]: code,
      [siblingFile]: code,
    })
    const { result } = await runCodemod("nuxt-safe-runtime-config", { cwd })
    expect(await readFile(join(cwd, nestedFile), "utf8")).toBe(code)
    expect(await readFile(join(cwd, configFile), "utf8")).toBe(config)
    expect(await readFile(join(cwd, directory, "package.json"), "utf8")).toBe(nestedPackage)
    expect(result.edits.some(edit => edit.path.startsWith(`${directory}/`))).toBe(false)
    expect(result.followUps.some(entry => entry.file === configFile)).toBe(true)
    for (const file of ["composables/title.ts", siblingFile]) {
      expect(await readFile(join(cwd, file), "utf8")).toContain("usePublicEnv().title")
    }
  })

  it.each([
    ["themes/base", "extends: ['./themes/base'],", ""],
    ["themes/tuple", "extends: [['./themes/tuple', {}]],", ""],
    ["themes/dynamic", "extends: activeLayers,", "const activeLayers = ['./themes/dynamic']\n"],
    ["layers/base", "", ""],
  ])("migrates consumed layer source in %s while protecting child apps", async (directory, extendsOption, preamble) => {
    const code = "export default defineEventHandler(() => useSafeRuntimeConfig().public.title)\n"
    const cwd = await app({
      "nuxt.config.ts": `${preamble}export default defineNuxtConfig({ ${extendsOption} modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { envSchema: '.env.example' } })`,
      ".env.example": "NUXT_PUBLIC_TITLE=site\n",
      [`${directory}/nuxt.config.ts`]: "export default defineNuxtConfig({ extends: ['../shared'] })",
      [`${directory}/server/api/title.get.ts`]: code,
      [`${directory}/apps/child/nuxt.config.ts`]: "export default defineNuxtConfig({})",
      [`${directory}/apps/child/server/api/title.get.ts`]: code,
      [`${posix.dirname(directory)}/shared/nuxt.config.ts`]: "export default defineNuxtConfig({})",
      [`${posix.dirname(directory)}/shared/server/api/title.get.ts`]: code,
    })
    const { result } = await runCodemod("nuxt-safe-runtime-config", { cwd })
    for (const layer of [directory, `${posix.dirname(directory)}/shared`]) {
      expect(await readFile(join(cwd, layer, "server/api/title.get.ts"), "utf8")).toContain("usePublicEnv().title")
      expect(result.followUps.some(entry => entry.file === `${layer}/nuxt.config.ts`)).toBe(false)
    }
    expect(await readFile(join(cwd, directory, "apps/child/server/api/title.get.ts"), "utf8")).toBe(code)
    expect(result.followUps.some(entry => entry.file === `${directory}/apps/child/nuxt.config.ts`)).toBe(true)
  })
})

describe("module list safety", () => {
  it("rejects modules inherited through a root spread without writing files", async () => {
    const files = {
      "nuxt.config.ts": "const base = { modules: ['@nuxt/eslint', 'nuxt-safe-runtime-config'] }\nexport default defineNuxtConfig({ ...base, safeRuntimeConfig: { envSchema: '.env.example' } })",
      ".env.example": "NUXT_PUBLIC_TITLE=site\n",
      "package.json": '{"dependencies":{"nuxt-safe-runtime-config":"0.3.2"}}\n',
      "composables/title.ts": "export const title = useSafeRuntimeConfig().public.title\n",
    }
    const cwd = await app(files)
    await expect(runCodemod("nuxt-safe-runtime-config", { cwd })).rejects.toThrow(/root spread.*modules.*array literal/)
    for (const [file, code] of Object.entries(files)) expect(await readFile(join(cwd, file), "utf8")).toBe(code)
  })

  it.each(["buildModules()", "activeModules", "enabled ? activeModules : []"])("rejects modules: %s without writing files", async (modules) => {
    const files = {
      "nuxt.config.ts": `const activeModules = ['@nuxt/eslint', 'nuxt-safe-runtime-config']\nconst buildModules = () => activeModules\nconst enabled = true\nexport default defineNuxtConfig({ modules: ${modules}, safeRuntimeConfig: { envSchema: '.env.example' } })`,
      ".env.example": "NUXT_PUBLIC_TITLE=site\n",
      "package.json": '{"dependencies":{"nuxt-safe-runtime-config":"0.3.2"}}\n',
      "composables/title.ts": "export const title = useSafeRuntimeConfig().public.title\n",
    }
    const cwd = await app(files)
    await expect(runCodemod("nuxt-safe-runtime-config", { cwd })).rejects.toThrow(/modules.*array literal/)
    for (const [file, code] of Object.entries(files)) expect(await readFile(join(cwd, file), "utf8")).toBe(code)
  })
})

describe("host safety", () => {
  it.each(["process.env.NITRO_PRESET", "deploymentPreset", "selectPreset()"])("rejects nitro.preset: %s without writing files", async (preset) => {
    const files = {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { envSchema: '.env.example' }, nitro: { preset: ${preset} } })`,
      ".env.example": "NUXT_PUBLIC_TITLE=site\n",
      "package.json": '{"dependencies":{"nuxt-safe-runtime-config":"0.3.2"}}\n',
      "composables/title.ts": "export const title = useSafeRuntimeConfig().public.title\n",
    }
    const cwd = await app(files)
    await expect(runCodemod("nuxt-safe-runtime-config", { cwd })).rejects.toThrow(/nitro.preset.*string literal/)
    for (const [file, code] of Object.entries(files)) expect(await readFile(join(cwd, file), "utf8")).toBe(code)
  })

  it.each([
    "modules: ['nuxt-safe-runtime-config'], vitehub: { host: 'cloudflare' }",
    "modules: ['nuxt-safe-runtime-config', ['vite-hub/nuxt', { host: 'cloudflare' }]]",
  ])("keeps an explicit ViteHub host with a dynamic Nitro preset: %s", async (options) => {
    const cwd = await app({
      "nuxt.config.ts": `export default defineNuxtConfig({ ${options}, safeRuntimeConfig: { envSchema: '.env.example' }, nitro: { preset: process.env.NITRO_PRESET } })`,
      ".env.example": "NUXT_PUBLIC_TITLE=site\n",
    })
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd, dryRun: true })
    const edited = run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after
    expect(edited).toContain("host: 'cloudflare'")
    expect(edited).toContain("preset: process.env.NITRO_PRESET")
    expect(edited).not.toContain("host: 'node'")
  })
})

describe("schema migration safety", () => {
  it.each([
    ["title", true, "''"],
    ["title", false, "''"],
    ["title", true, "process.env.SOURCE ?? ''"],
    ["title", false, "process.env.SOURCE ?? ''"],
    ["apiSecret", true, "''"],
    ["apiSecret", false, "process.env.SOURCE ?? ''"],
  ])("keeps an empty string default for %s (required: %s, value: %s)", async (name, required, value) => {
    const cwd = await app({ "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], runtimeConfig: { ${name}: ${value} } })` })
    const config = await readNuxtConfig(cwd)
    const plan = planFromJsonSchema({
      jsonSchema: { type: "object", required: required ? [name] : [], properties: { [name]: { type: "string", ...(value.includes("process.env") ? { default: "schema-default" } : {}) } } },
      issues: new Map(),
      runtimeConfig: readRuntimeConfig(config).values,
    })
    expect(plan.fields[0]).toMatchObject({ default: "", required })
    const edited = editNuxtConfig({ config, env: { kind: "fields", fields: plan.fields }, migrated: new Set([name]) })
    expect(edited.code).not.toContain("runtimeConfig")
    const exported = parseProgram(edited.code).program.body.find(node => node.type === "ExportDefaultDeclaration")
    if (exported?.type !== "ExportDefaultDeclaration") throw new Error("Missing migrated config")
    const migrated: { vitehub: { env: { server: EnvRuntimeConfigOptions } } } = runInNewContext(edited.code.slice(start(exported.declaration), end(exported.declaration)), { defineNuxtConfig: (options: unknown) => options, env })
    vi.stubEnv("NUXT_TITLE", undefined)
    vi.stubEnv("NUXT_API_SECRET", undefined)
    for (const source of [undefined, "", "configured"]) {
      vi.stubEnv("SOURCE", source)
      const registry = createRuntimeEnvRegistry({ ...migrated.vitehub.env.server }, { prefix: false })
      const resolved = resolveServerEnv(registry)[name]
      if (name === "apiSecret") expect(resolved).toBeInstanceOf(SecretEnv)
      expect(resolved instanceof SecretEnv ? resolved.unseal() : resolved).toBe(value.includes("process.env") ? source ?? "" : "")
    }
  })

  it.each([
    ["__proto__"],
    ["group", "__proto__"],
    ["__proto__", "__vitehubProtoValue"],
  ])("preserves prototype-like Env paths %j as own properties", async (...path) => {
    const value = path.reduceRight((child, key) => `{ [${JSON.stringify(key)}]: ${child} }`, "'retained'")
    const cwd = await app({ "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], runtimeConfig: ${value}, nitro: { preset: 'node-server' } })` })
    const config = await readNuxtConfig(cwd)
    const schema = path.reduceRight<Record<string, unknown>>((child, key) => ({ type: "object", required: [key], properties: Object.fromEntries([[key, child]]) }), { type: "string" })
    const plan = planFromJsonSchema({ jsonSchema: schema, issues: new Map(), runtimeConfig: readRuntimeConfig(config).values })
    expect(plan.fields).toHaveLength(1)
    try {
      const edited = editNuxtConfig({ config, env: { kind: "fields", fields: plan.fields }, migrated: new Set([path.join(".")]) })
      const exported = parseProgram(edited.code).program.body.find(node => node.type === "ExportDefaultDeclaration")
      if (exported?.type !== "ExportDefaultDeclaration") throw new Error("Missing migrated config")
      const env = Object.assign((options: { default: string }) => options.default, { source: (name: string) => name })
      const migrated: { vitehub: { env: { server: unknown } } } = runInNewContext(edited.code.slice(start(exported.declaration), end(exported.declaration)), { defineNuxtConfig: (options: unknown) => options, env })
      let current: unknown = migrated.vitehub.env.server
      for (const segment of path) {
        if (typeof current !== "object" || current === null) throw new Error("Missing Env group")
        expect(Object.hasOwn(current, segment)).toBe(true)
        current = Object.getOwnPropertyDescriptor(current, segment)?.value
      }
      expect(current).toBe("retained")
      expect(Object.hasOwn(Object.prototype, "__vitehubProtoValue")).toBe(false)
    }
    finally {
      Reflect.deleteProperty(Object.prototype, "__vitehubProtoValue")
    }
  })

  it("keeps the separator when removing the last inline runtimeConfig property", async () => {
    const cwd = await app({ "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], runtimeConfig: { title: 'site' } })" })
    const config = await readNuxtConfig(cwd)
    const edited = editNuxtConfig({ config, env: { kind: "fields", fields: [] }, migrated: new Set(["title"]) })
    expect(() => parseProgram(edited.code)).not.toThrow()
    expect(edited.code).not.toContain("runtimeConfig")
  })

  it.each(["string", "number", "boolean"])("migrates || fallbacks for %s to an Env source that skips empty values", async (type) => {
    const fallback = type === "string" ? "'fallback'" : type === "number" ? "7" : "true"
    const cwd = await app({ "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], runtimeConfig: { value: process.env.SOURCE || ${fallback} } })` })
    const config = await readNuxtConfig(cwd)
    const plan = planFromJsonSchema({ jsonSchema: { type: "object", required: ["value"], properties: { value: { type } } }, issues: new Map(), runtimeConfig: readRuntimeConfig(config).values })
    expect(plan.unmigrated).toEqual([])
    expect(plan.fields[0]).toMatchObject({ skipEmpty: true, extraVariables: ["SOURCE"] })
    const edited = editNuxtConfig({ config, env: { kind: "fields", fields: plan.fields }, migrated: new Set(["value"]) })
    expect(edited.code).toContain("source: env.source(['NUXT_VALUE', 'SOURCE'], { skipEmpty: true })")
    const exported = parseProgram(edited.code).program.body.find(node => node.type === "ExportDefaultDeclaration")
    if (exported?.type !== "ExportDefaultDeclaration") throw new Error("Missing migrated config")
    const migrated: { vitehub: { env: { server: EnvRuntimeConfigOptions } } } = runInNewContext(edited.code.slice(start(exported.declaration), end(exported.declaration)), { defineNuxtConfig: (options: unknown) => options, env })
    const parse = (value: unknown) => type === "number" ? Number(value) : type === "boolean" ? value === true || value === "true" : value
    vi.stubEnv("NUXT_VALUE", undefined)
    // Unset, empty, and configured sources resolve as the original expression did, parsed to the field type.
    for (const source of [undefined, "", type === "string" ? "configured" : type === "number" ? "2" : "false"]) {
      vi.stubEnv("SOURCE", source)
      const original: unknown = runInNewContext(`process.env.SOURCE || ${fallback}`, { process: { env: { SOURCE: source } } })
      const registry = createRuntimeEnvRegistry({ ...migrated.vitehub.env.server }, { prefix: false })
      expect(resolveServerEnv(registry).value).toBe(parse(original))
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

describe("schema conversion", () => {
  it("reports Zod 3 input coercion through wrappers instead of silently changing accepted inputs", async () => {
    const { z } = await import("zod/v3")
    const schema = z.object({
      count: z.coerce.number().optional().brand(),
      title: z.coerce.string().nullable(),
      enabled: z.coerce.boolean().readonly(),
      nullableCount: z.union([z.coerce.number(), z.null()]),
      plain: z.number(),
    })
    const issues = schemaIssues(schema)
    const plan = planFromJsonSchema({ jsonSchema: await schemaToJsonSchema(schema), issues, runtimeConfig: new Map() })
    for (const [name, type] of [["count", "number"], ["title", "string"], ["enabled", "boolean"], ["nullableCount", "number"]]) {
      expect(issues.get(name)?.join(" ")).toContain(`z.coerce.${type}()`)
      expect(plan.followUps.some(entry => entry.message.includes(name) && entry.message.includes(`z.coerce.${type}()`))).toBe(true)
    }
    expect(issues.has("plain")).toBe(false)
    for (const value of ["", " "]) {
      expect(schema.shape.count.parse(value)).toBe(0)
      vi.stubEnv("NUXT_VALUE", value)
      const registry = createRuntimeEnvRegistry({ value: env.number({ source: env.source("NUXT_VALUE") }) }, { prefix: false })
      expect(() => resolveServerEnv(registry)).toThrow()
    }
  })

  it("keeps Zod 3 catch fallbacks and their reads out of automatic migration", async () => {
    const { z } = await import("zod/v3")
    const schema = z.object({ value: z.string().catch("fallback"), title: z.string() })
    expect(schema.parse({ title: "site" })).toEqual({ value: "fallback", title: "site" })
    expect(schema.parse({ value: 42, title: "site" })).toEqual({ value: "fallback", title: "site" })
    const cwd = await app({
      "nuxt.config.ts": "export default defineNuxtConfig({ runtimeConfig: { value: 'configured', title: 'site' } })",
      "server/api/config.ts": "export default () => useSafeRuntimeConfig().value",
    })
    const config = await readNuxtConfig(cwd)
    const plan = planFromJsonSchema({ jsonSchema: await schemaToJsonSchema(schema), issues: schemaIssues(schema), runtimeConfig: readRuntimeConfig(config).values })
    expect(plan.fields.map(field => field.configPath)).toEqual([["title"]])
    expect(plan.unmigrated).toEqual(["value"])
    expect(plan.followUps).toContainEqual(expect.objectContaining({ message: expect.stringContaining("Zod catch fallback") }))
    const edited = editNuxtConfig({ config, env: { kind: "fields", fields: plan.fields }, migrated: new Set(["title"]) })
    expect(edited.code).toContain("value: 'configured'")
    const calls = await rewriteCallSites({ cwd, fields: plan.fields, unmigrated: plan.unmigrated })
    expect(calls.edits).toEqual([])
    expect(calls.remaining).toEqual(["server/api/config.ts"])
  })

  it("keeps unsupported Zod 3 wrappers unknown even inside supported wrappers", async () => {
    const { z } = await import("zod/v3")
    const schema = z.object({
      optional: z.string().catch("fallback").optional(),
      nullable: z.string().catch("fallback").nullable(),
      branded: z.string().catch("fallback").brand(),
      readonly: z.string().catch("fallback").readonly(),
      defaulted: z.string().catch("fallback").default("default"),
      public: z.object({ value: z.number().catch(7) }),
      promised: z.string().promise(),
    })
    const plan = planFromJsonSchema({ jsonSchema: await schemaToJsonSchema(schema), issues: schemaIssues(schema), runtimeConfig: new Map() })
    expect(plan.fields).toEqual([])
    expect(plan.unmigrated).toEqual(["optional", "nullable", "branded", "readonly", "defaulted", "public.value", "promised"])
  })

  it("reports Zod 3 transforms and checks that Env cannot keep, including branded refinements", async () => {
    const { z } = await import("zod/v3")
    const schema = z.object({
      title: z.string().trim().toLowerCase(),
      code: z.string().toUpperCase(),
      prefix: z.string().startsWith("app-"),
      count: z.number().multipleOf(2),
      refined: z.string().refine(value => value.length > 2).brand(),
    })
    expect(schema.parse({ title: " TITLE ", code: "abc", prefix: "app-code", count: 4, refined: "okay" }))
      .toEqual({ title: "title", code: "ABC", prefix: "app-code", count: 4, refined: "okay" })
    expect(schema.safeParse({ title: "title", code: "abc", prefix: "other", count: 3, refined: "no" }).success).toBe(false)
    const issues = schemaIssues(schema)
    expect(issues.get("title")).toEqual(["a Zod trim transform", "a Zod toLowerCase transform"])
    expect(issues.get("code")).toEqual(["a Zod toUpperCase transform"])
    expect(issues.get("prefix")).toEqual(["the Zod startsWith check"])
    expect(issues.get("count")).toEqual(["the Zod multipleOf check"])
    expect(issues.get("refined")).toEqual(["a Zod refinement"])
    const jsonSchema = await schemaToJsonSchema(schema)
    const plan = planFromJsonSchema({ jsonSchema, issues, runtimeConfig: new Map() })
    expect(plan.fields).toHaveLength(5)
    for (const name of Object.keys(schema.shape)) {
      expect(plan.followUps).toContainEqual(expect.objectContaining({ message: expect.stringContaining(`${name}: Env does not keep`) }))
    }
  })

  it("preserves optional Zod 3 inputs through wrappers", async () => {
    const { z } = await import("zod/v3")
    const schema = z.object({
      readonly: z.string().optional().readonly(),
      branded: z.string().optional().brand(),
      transformed: z.string().optional().transform(value => value),
      piped: z.string().optional().pipe(z.string().optional()),
      defaulted: z.string().default("fallback").readonly(),
    })
    expect(schema.parse({})).toEqual({ defaulted: "fallback" })
    const jsonSchema = await schemaToJsonSchema(schema)
    const plan = planFromJsonSchema({ jsonSchema, issues: schemaIssues(schema), runtimeConfig: new Map() })
    expect(plan.fields).toHaveLength(5)
    expect(plan.fields.every(field => !field.required)).toBe(true)
    expect(plan.fields.find(field => field.configPath[0] === "defaulted")?.default).toBe("fallback")
  })

  it.each<{ name: string, values: EnumLike, expected: (string | number)[], supported: boolean }>([
    { name: "numeric", values: { 0: "Off", 1: "On", Off: 0, On: 1 }, expected: [0, 1], supported: false },
    { name: "mixed", values: { 0: "Off", Off: 0, On: "on" }, expected: [0, "on"], supported: false },
    { name: "string", values: { Off: "off", On: "on" }, expected: ["off", "on"], supported: true },
  ])("uses values rather than reverse mappings for $name Zod 3 native enums", async ({ values, expected, supported }) => {
    const { z } = await import("zod/v3")
    const schema = z.object({ mode: z.nativeEnum(values) })
    for (const value of expected) expect(schema.safeParse({ mode: value }).success).toBe(true)
    const jsonSchema = await schemaToJsonSchema(schema)
    expect(jsonSchema).toMatchObject({ properties: { mode: { enum: expected } } })
    const plan = planFromJsonSchema({ jsonSchema, issues: schemaIssues(schema), runtimeConfig: new Map() })
    if (supported) {
      expect(plan.fields[0]).toMatchObject({ kind: "enum", values: expected })
      expect(plan.unmigrated).toEqual([])
    }
    else {
      expect(plan.fields).toEqual([])
      expect(plan.unmigrated).toEqual(["mode"])
      expect(plan.followUps[0]?.message).toContain("stays in runtimeConfig")
    }
  })

  it("reads Zod 3 schemas, which have no JSON Schema output", async () => {
    const { z } = await import("zod/v3")
    const schema = z.object({
      apiUrl: z.string().url().min(3),
      retries: z.coerce.number().int().min(1),
      mode: z.enum(["off", "on"]).default("off"),
      flag: z.string().transform(value => value === "true").optional(),
      enabled: z.coerce.boolean(),
      public: z.object({ siteName: z.string().optional() }),
    })
    expect(await schemaToJsonSchema(schema)).toEqual({
      type: "object",
      required: ["apiUrl", "retries", "enabled", "public"],
      properties: {
        apiUrl: { type: "string", format: "uri", minLength: 3 },
        retries: { type: "integer", minimum: 1 },
        mode: { type: "string", enum: ["off", "on"], default: "off" },
        flag: { type: "string" },
        enabled: { type: "boolean" },
        public: { type: "object", required: [], properties: { siteName: { type: "string" } } },
      },
    })
    const issues = schemaIssues(schema)
    expect(issues.get("flag")).toEqual(["a Zod transform"])
    expect(issues.get("enabled")?.[0]).toContain("z.coerce.boolean()")
  })
})
