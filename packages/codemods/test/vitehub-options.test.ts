import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { migrateViteHubOptions } from "../src/vitehub-options/transform.ts"

const scratch = fileURLToPath(new URL("../.tmp/vitehub-options-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

function lines(...values: string[]): string {
  return `${values.join("\n")}\n`
}

describe("vitehub-options transform", () => {
  it("moves logs into observability, env into vitehub(), and removes contentImportBase", () => {
    const input = lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "import { env } from 'vite-hub/env'",
      "",
      "export default defineConfig({",
      "  env: {",
      "    server: {",
      "      token: env({ secret: true }),",
      "    },",
      "  },",
      "  plugins: [",
      "    vitehub({",
      "      host: 'node',",
      "      contentImportBase: 'vite-hub/content',",
      "      logs: { source: './server/logs.ts', evlog: { pretty: true } },",
      "      observability: { service: 'shop' },",
      "    }),",
      "  ],",
      "})",
    )
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toBe(lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "import { env } from 'vite-hub/env'",
      "",
      "export default defineConfig({",
      "  plugins: [",
      "    vitehub({",
      "      host: 'node',",
      "      observability: {",
      "        service: 'shop',",
      "        evlog: { pretty: true },",
      "        logs: { source: './server/logs.ts' },",
      "      },",
      "      env: {",
      "        server: {",
      "          token: env({ secret: true }),",
      "        },",
      "      },",
      "    }),",
      "  ],",
      "})",
    ))
    expect(result.followUps).toEqual([])
    expect(result.notes).toEqual(["vite.config.ts: removed contentImportBase. ViteHub always imports Content from vite-hub/content."])
  })

  it("renames logs in place when observability is not set", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ host: 'node', logs: true })] }\n"
    expect(migrateViteHubOptions("vite.config.ts", input).code)
      .toBe("import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ host: 'node', observability: { logs: true } })] }\n")
  })

  it.each(["", ", observability: false", ", observability: true", ", observability: { service: 'app' }"])("preserves disabled Logs with observability %s", (observability) => {
    const input = `import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ logs: false${observability} })] }\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).not.toContain("logs:")
    expect(result.code.replace(/\s+/g, "")).toContain(`vitehub({${observability.slice(1)}})`.replace(/\s+/g, ""))
    expect(result.followUps).toEqual([])
  })

  it.each([
    "import { env } from 'vite-hub/env'\nfunction vitehub(options) { return options }",
    "import { vitehub } from 'another-package'\nimport { env } from 'vite-hub/env'",
  ])("leaves unrelated vitehub calls unchanged", (imports) => {
    const input = `${imports}\nexport default { plugins: [vitehub({ logs: true, contentImportBase: 'custom' })] }\n`
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(input)
  })

  it.each([
    ["hubKv", "kv", "{ driver: 'fs-lite' }"],
    ["hubKV", "kv", "{ driver: 'fs-lite' }"],
    ["hubEnv", "env", "{ server: {} }"],
  ])("leaves unrelated %s calls unchanged", (name, key, value) => {
    const input = `import { env } from 'vite-hub/env'\nfunction ${name}() {}\nexport default { plugins: [${name}()], ${key}: ${value} }\n`
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(input)
  })

  it.each([
    ["vitehub", "vite-hub", "{ logs: true }", ""],
    ["hubEnv", "@vite-hub/env/vite", "", ", env: { server: {} }"],
    ["hubKv", "@vite-hub/kv/vite", "", ", kv: { driver: 'fs-lite' }"],
    ["hubKV", "@vite-hub/kv/vite", "", ", kv: { driver: 'fs-lite' }"],
    ["hubDatabase", "@vite-hub/database/vite", "", ", database: { cli: false }"],
  ])("leaves shadowed %s calls unchanged", (name, source, argument, options) => {
    const input = `import { ${name} } from '${source}'\nexport default defineConfig((${name}) => ({ plugins: [${name}(${argument})]${options} }))\n`
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(input)
  })

  it.each([
    ["vitehub", "vite-hub", "{ logs: true }", "", "observability: { logs: true }"],
    ["hubEnv", "@vite-hub/env/vite", "", ", env: { server: {} }", "hubEnv({ server: {} })"],
    ["hubKv", "@vite-hub/kv/vite", "", ", kv: { driver: 'fs-lite' }", "hubKv({ driver: 'fs-lite' })"],
    ["hubKV", "@vite-hub/kv/vite", "", ", kv: { driver: 'fs-lite' }", "hubKV({ driver: 'fs-lite' })"],
    ["hubDatabase", "@vite-hub/database/vite", "", ", database: { cli: false }", "hubDatabase({ cli: false })"],
  ])("migrates imported %s calls beside unrelated nested bindings", (name, source, argument, options, expected) => {
    const input = `import { ${name} } from '${source}'\nfunction helper(${name}) { return ${name}(${argument}) }\nexport default { plugins: [${name}(${argument})]${options} }\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(true)
    expect(result.code).toContain(expected)
    expect(result.code).toContain(`function helper(${name}) { return ${name}(${argument}) }`)
    expect(result.followUps).toEqual([])
  })

  it.each([
    "() => { const helper = () => ({ logs: false }); return CONFIG }",
    "function () { return CONFIG }",
    "async function () { return CONFIG }",
  ])("migrates a block-bodied config factory: %s", (factory) => {
    const input = `import { vitehub } from 'vite-hub'\nexport default defineConfig(${factory.replace("CONFIG", "{ plugins: [vitehub({ logs: true })], env: { server: {} }, kv: { driver: 'fs-lite' } }")})\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(true)
    expect(result.followUps).toEqual([])
    expect(result.code).toContain("observability: { logs: true }")
    expect(result.code).toContain("env: { server: {} }")
    expect(result.code).toContain("kv: { driver: 'fs-lite' }")
    expect(migrateViteHubOptions("vite.config.ts", result.code).changed).toBe(false)
  })

  it("migrates an exported config function", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default function config() { return { plugins: [vitehub({ logs: true })] } }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toContain("observability: { logs: true }")
    expect(result.followUps).toEqual([])
  })

  it("migrates owner options returned by a function factory", () => {
    const input = "import { hubKv } from '@vite-hub/kv/vite'\nexport default defineConfig(function () { return { plugins: [hubKv()], kv: { driver: 'fs-lite' } } })\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toContain("hubKv({ driver: 'fs-lite' })")
    expect(result.followUps).toEqual([])
  })

  it("migrates Nuxt Env declarations returned by a block-bodied factory", () => {
    const input = "export default defineNuxtConfig(() => { return { modules: ['vite-hub/nuxt'], vitehub: {}, vite: { env: { server: {} } } } })\n"
    const result = migrateViteHubOptions("nuxt.config.ts", input)
    expect(result.changed).toBe(true)
    expect(result.code).toContain("vitehub:")
    expect(result.code).toContain("env: { server: {} }")
    expect(result.followUps).toEqual([])
  })

  it.each([
    "() => { if (process.env.PROD) return { plugins: [vitehub()], env: {} }; return { plugins: [vitehub()], kv: {} } }",
    "function () { const config = { plugins: [vitehub()], env: {} }; return config }",
  ])("reports config factories that need manual migration", (factory) => {
    const input = `import { vitehub } from 'vite-hub'\nexport default defineConfig(${factory})\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toBe(input)
    expect(result.followUps).toEqual([expect.objectContaining({ file: "vite.config.ts", message: expect.stringContaining("by hand") })])
  })

  it("migrates an imported alias", () => {
    const input = "import { vitehub as hub } from 'vite-hub'\nexport default { plugins: [hub({ logs: true })] }\n"
    expect(migrateViteHubOptions("vite.config.ts", input).code).toContain("hub({ observability: { logs: true } })")
  })

  it("adds the Env options to a vitehub() call without options", () => {
    const input = lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "",
      "export default defineConfig({",
      "  plugins: [vitehub()],",
      "  env: {",
      "    public: { appName: env({ default: 'Acme', mode: 'build' }) },",
      "  },",
      "})",
    )
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "",
      "export default defineConfig({",
      "  plugins: [vitehub({",
      "    env: {",
      "      public: { appName: env({ default: 'Acme', mode: 'build' }) },",
      "    },",
      "  })],",
      "})",
    ))
  })

  it("passes top-level options to standalone owner plugins", () => {
    const input = lines(
      "import { envSchema, hubEnv } from '@vite-hub/env/vite'",
      "import { hubKv } from '@vite-hub/kv/vite'",
      "import { defineConfig } from 'vite'",
      "",
      "export default defineConfig({",
      "  plugins: [hubEnv({ prefix: 'APP_' }), hubKv()],",
      "  env: envSchema(new URL('./.env.example', import.meta.url)),",
      "  kv: { driver: 'fs-lite' },",
      "})",
    )
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(lines(
      "import { envSchema, hubEnv } from '@vite-hub/env/vite'",
      "import { hubKv } from '@vite-hub/kv/vite'",
      "import { defineConfig } from 'vite'",
      "",
      "export default defineConfig({",
      "  plugins: [hubEnv({",
      "    prefix: 'APP_',",
      "    ...envSchema(new URL('./.env.example', import.meta.url)),",
      "  }), hubKv({ driver: 'fs-lite' })],",
      "})",
    ))
  })

  it.each([
    ["vite.config.ts", "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ host: 'cloudflare' })], sandboxTask: { provider: 'cloudflare' } }\n", "import{vitehub}from'vite-hub'exportdefault{plugins:[vitehub({host:'cloudflare',sandboxTask:{provider:'cloudflare'},})]}"],
    ["nuxt.config.ts", "export default defineNuxtConfig({ modules: ['vite-hub/nuxt'], vitehub: {}, vite: { sandboxTask: { provider: 'cloudflare' } } })\n", "exportdefaultdefineNuxtConfig({modules:['vite-hub/nuxt'],vitehub:{sandboxTask:{provider:'cloudflare'},},vite:{}})"],
    ["nuxt.config.ts", "export default defineNuxtConfig({ modules: [['vite-hub/nuxt', {}]], vite: { sandboxTask: taskOptions } })\n", "exportdefaultdefineNuxtConfig({modules:[['vite-hub/nuxt',{sandboxTask:taskOptions,}]],vite:{}})"],
  ])("moves Sandbox Task options into the framework options in %s", (file, input, output) => {
    const result = migrateViteHubOptions(file, input)
    expect(result.changed).toBe(true)
    expect(result.code.replace(/\s+/g, "")).toBe(output)
    expect(result.followUps).toEqual([])
  })

  it.each(["true", "false"])("migrates boolean Sandbox Task enablement: %s", (value) => {
    const input = `import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({})], sandboxTask: ${value} }\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(true)
    expect(result.code.replace(/\s+/g, "")).toBe(`import{vitehub}from'vite-hub'exportdefault{plugins:[vitehub({sandboxTask:${value},})]}`)
    expect(result.followUps).toEqual([])
  })

  it.each(["@vite-hub/sandbox/task/vite", "vite-hub/sandbox/task/vite"])("passes Sandbox Task options to the standalone plugin from %s", (source) => {
    const input = `import { hubSandboxTask as tasks } from '${source}'\nexport default { plugins: [tasks()], sandboxTask: { provider: 'cloudflare' } }\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toBe(`import { hubSandboxTask as tasks } from '${source}'\nexport default { plugins: [tasks({ provider: 'cloudflare' })] }\n`)
    expect(result.followUps).toEqual([])
  })

  it("moves vite.env into the vite-hub/nuxt options", () => {
    const input = lines(
      "export default defineNuxtConfig({",
      "  modules: [['vite-hub/nuxt', { auth: true, host: 'cloudflare' }]],",
      "  vite: {",
      "    env: {",
      "      server: { auth: { secret: env({ secret: true }) } },",
      "    },",
      "  } as never,",
      "})",
    )
    expect(migrateViteHubOptions("nuxt.config.ts", input).code).toBe(lines(
      "export default defineNuxtConfig({",
      "  modules: [['vite-hub/nuxt', {",
      "    auth: true,",
      "    host: 'cloudflare',",
      "    env: {",
      "      server: { auth: { secret: env({ secret: true }) } },",
      "    },",
      "  }]],",
      "})",
    ))
  })

  it("reports what it cannot move", () => {
    const input = lines(
      "import { vitehub } from 'vite-hub'",
      "export default {",
      "  env: { server: {} },",
      "  plugins: [vitehub({ env: false, logs: isDev ? true : { source: './server/logs.ts' } })],",
      "}",
    )
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps.map(followUp => followUp.message)).toEqual([
      expect.stringContaining("logs is an expression"),
      expect.stringContaining("vitehub({ env: false }) turns Env off"),
    ])
  })

  it("leaves configs that use the current options unchanged", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { logs: true }, env: { server: {} } })] }\n"
    expect(migrateViteHubOptions("vite.config.ts", input)).toMatchObject({ changed: false, code: input, followUps: [] })
  })
})

describe("vitehub-options codemod", () => {
  it.each([
    ["vitehub-options", "renamed-apis"],
    ["renamed-apis", "vitehub-options"],
  ])("composes API and options migrations in order %s, %s", async (first, second) => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    const config = join(cwd, "vite.config.ts")
    await writeFile(config, lines(
      "import { hubKv } from '@vite-hub/kv/vite'",
      "import { hubDb } from '@vite-hub/database/vite'",
      "export default { plugins: [hubKv(), hubDb()], kv: { driver: 'fs-lite' }, database: { cli: false } }",
    ))
    for (const name of [first, second]) {
      const run = await runCodemod(name, { cwd })
      expect(run.result.followUps).toEqual([])
    }
    const output = await readFile(config, "utf8")
    expect(output).toContain("hubKV({ driver: 'fs-lite' })")
    expect(output).toContain("hubDatabase({ cli: false })")
    expect(output).not.toMatch(/\b(?:hubKv|hubDb)\b/)
  })

  it("edits config files and reports renamed option types", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    await writeFile(join(cwd, "vite.config.ts"), "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ logs: true })] }\n")
    await mkdir(join(cwd, "src"))
    await writeFile(join(cwd, "src/config.ts"), "import type { KVModuleOptions } from 'vite-hub'\nexport const kv: KVModuleOptions = false\n")
    const run = await runCodemod("vitehub-options", { cwd })
    expect(await readFile(join(cwd, "vite.config.ts"), "utf8")).toBe("import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { logs: true } })] }\n")
    expect(formatReport(run)).toContain("src/config.ts:1 KVModuleOptions is now KVOptions.")
  })
})
