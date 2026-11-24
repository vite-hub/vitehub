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
  it("moves logs.evlog into observability, env into vitehub(), and removes contentImportBase", () => {
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
      "      logs: { source: './server/logs.ts' },",
      "      observability: {",
      "        service: 'shop',",
      "        evlog: { pretty: true },",
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

  it("moves observability.logs to logs, and drops an observability key that held only logs", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ host: 'node', observability: { logs: true } })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toBe("import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ host: 'node', logs: true })] }\n")
    expect(migrateViteHubOptions("vite.config.ts", result.code).changed).toBe(false)
  })

  it("moves observability.logs to logs and keeps the other observability options", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { service: 'shop', logs: { source: './server/logs.ts' } } })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code.replace(/\s+/g, "")).toBe("import{vitehub}from'vite-hub'exportdefault{plugins:[vitehub({observability:{service:'shop'},logs:{source:'./server/logs.ts'}})]}")
    expect(result.followUps).toEqual([])
  })

  it("reports observability.logs when logs is also set", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ logs: true, observability: { logs: { source: './a.ts' } } })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps).toEqual([expect.objectContaining({ message: expect.stringContaining("Both logs and observability.logs are set") })])
  })

  it.each(["", "vitehub: { observability: { logs: false }, console: false }, "])("moves Nuxt development overrides (%s)", (base) => {
    const input = `export default defineNuxtConfig({ modules: ['vite-hub/nuxt'], ${base}$development: { vitehub: { observability: { logs: true }, console: { auth: false } } } })`
    const result = migrateViteHubOptions("nuxt.config.ts", input)
    expect(result.followUps).toEqual([])
    expect(result.code).toContain("$development: { vitehub: { logs: true, console: { auth: false } } }")
    if (base) expect(result.code).toContain("vitehub: { observability: true, logs: false, console: false }")
  })

  it("preserves parentheses around a sequence expression", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { logs: (console.log('config'), true) } })] }"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.followUps).toEqual([])
    expect(result.code).toContain("logs: (console.log('config'), true)")
  })

  it.each(["{ source: './logs.ts' }, evlog: { pretty: true }", "loadLogs()"])("reports a manual follow-up when moving %s could change Evlog registration", (value) => {
    const input = `import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { logs: ${value} } })] }`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toBe(input)
    expect(result.followUps).toEqual([expect.objectContaining({ message: expect.stringContaining("Evlog") })])
  })

  it("reports observability.logs inside an expression", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: dev ? { logs: true } : false })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps).toEqual([expect.objectContaining({ message: expect.stringContaining("Move observability.logs to the top-level logs key by hand") })])
  })

  it.each(["", ", observability: false", ", observability: true", ", observability: { service: 'app' }"])("keeps logs: false with observability %s", (observability) => {
    const input = `import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ logs: false${observability} })] }\n`
    expect(migrateViteHubOptions("vite.config.ts", input)).toMatchObject({ changed: false, code: input, followUps: [] })
  })

  it.each([
    "import { env } from 'vite-hub/env'\nfunction vitehub(options) { return options }",
    "import { vitehub } from 'another-package'\nimport { env } from 'vite-hub/env'",
  ])("leaves unrelated vitehub calls unchanged", (imports) => {
    const input = `${imports}\nexport default { plugins: [vitehub({ observability: { logs: true }, contentImportBase: 'custom' })] }\n`
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
    ["vitehub", "vite-hub", "{ observability: { logs: true } }", ""],
    ["hubEnv", "@vite-hub/env/vite", "", ", env: { server: {} }"],
    ["hubKv", "@vite-hub/kv/vite", "", ", kv: { driver: 'fs-lite' }"],
    ["hubKV", "@vite-hub/kv/vite", "", ", kv: { driver: 'fs-lite' }"],
    ["hubDatabase", "@vite-hub/database/vite", "", ", database: { cli: false }"],
  ])("leaves shadowed %s calls unchanged", (name, source, argument, options) => {
    const input = `import { ${name} } from '${source}'\nexport default defineConfig((${name}) => ({ plugins: [${name}(${argument})]${options} }))\n`
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(input)
  })

  it.each([
    ["vitehub", "vite-hub", "{ observability: { logs: true } }", "", "vitehub({ logs: true })"],
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
    const input = `import { vitehub } from 'vite-hub'\nexport default defineConfig(${factory.replace("CONFIG", "{ plugins: [vitehub({ observability: { logs: true } })], env: { server: {} }, kv: { driver: 'fs-lite' } }")})\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(true)
    expect(result.followUps).toEqual([])
    expect(result.code).toContain("logs: true")
    expect(result.code).not.toContain("observability")
    expect(result.code).toContain("env: { server: {} }")
    expect(result.code).toContain("kv: { driver: 'fs-lite' }")
    expect(migrateViteHubOptions("vite.config.ts", result.code).changed).toBe(false)
  })

  it("migrates an exported config function", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default function config() { return { plugins: [vitehub({ observability: { logs: true } })] } }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toContain("vitehub({ logs: true })")
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
    const input = "import { vitehub as hub } from 'vite-hub'\nexport default { plugins: [hub({ observability: { logs: true } })] }\n"
    expect(migrateViteHubOptions("vite.config.ts", input).code).toContain("hub({ logs: true })")
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
    ["vite.config.ts", "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ host: 'cloudflare' })], sandboxTask: { driver: 'cloudflare' } }\n", "import{vitehub}from'vite-hub'exportdefault{plugins:[vitehub({host:'cloudflare',sandboxTask:{driver:'cloudflare'},})]}"],
    ["nuxt.config.ts", "export default defineNuxtConfig({ modules: ['vite-hub/nuxt'], vitehub: {}, vite: { sandboxTask: { driver: 'cloudflare' } } })\n", "exportdefaultdefineNuxtConfig({modules:['vite-hub/nuxt'],vitehub:{sandboxTask:{driver:'cloudflare'},},vite:{}})"],
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
    const input = `import { hubSandboxTask as tasks } from '${source}'\nexport default { plugins: [tasks()], sandboxTask: { driver: 'cloudflare' } }\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toBe(`import { hubSandboxTask as tasks } from '${source}'\nexport default { plugins: [tasks({ driver: 'cloudflare' })] }\n`)
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
      "  plugins: [vitehub({ env: false, observability: isDev ? { logs: true } : { logs: { source: './server/logs.ts' } } })],",
      "}",
    )
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps.map(followUp => followUp.message)).toEqual([
      expect.stringContaining("observability is an expression, so the codemod cannot move its logs"),
      expect.stringContaining("vitehub({ env: false }) turns Env off"),
    ])
  })

  it("renames preset to host in a Nuxt config and keeps an expression value", () => {
    const input = lines(
      "export default defineNuxtConfig({",
      "  modules: ['vite-hub/nuxt', 'nuxt-og-image'],",
      "  vitehub: { preset: process.env.VERCEL ? 'vercel' : 'cloudflare' },",
      "})",
    )
    expect(migrateViteHubOptions("nuxt.config.ts", input)).toMatchObject({
      changed: true,
      code: input.replace("preset:", "host:"),
      followUps: [],
    })
  })

  it.each([
    ["vitehub({ preset: 'cloudflare' })", "vitehub({ host: 'cloudflare' })"],
    ["vitehub({ preset })", "vitehub({ host: preset })"],
    ["vitehub({ 'preset': 'vercel', sandbox: true })", "vitehub({ host: 'vercel', sandboxTask: true })"],
    ["vitehub({ host: 'node', devtools: true })", "vitehub({ host: 'node' })"],
    ["vitehub({ ['preset']: 'node', ['sandbox']: true })", "vitehub({ host: 'node', sandboxTask: true })"],
  ])("renames the removed vitehub() options in %s", (from, to) => {
    const input = `import { vitehub } from 'vite-hub'\nconst preset = 'node'\nexport default { plugins: [${from}] }\n`
    expect(migrateViteHubOptions("vite.config.ts", input)).toMatchObject({ changed: true, code: input.replace(from, to), followUps: [] })
  })

  it("reports preset next to host, sandbox options, and cloudflare", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ preset: 'node', host: 'node', sandbox: { cpu: 2 }, cloudflare: { secretsFile: '.env.prod' } })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps.map(followUp => followUp.message)).toEqual([
      expect.stringContaining("Both preset and host are set"),
      expect.stringContaining("sandbox is now sandboxTask"),
      expect.stringContaining("cloudflare.secretsFile was removed"),
    ])
  })

  it.each([
    ["vitehub({ console: { pill: true } })", "vitehub({ console: true })"],
    ["vitehub({ console: { pill: { position: 'bottom-left' }, mcpClient: true, auth: 'token' } })", "vitehub({ console: true })"],
    ["vitehub({ console: { pill: true, authorize: './server/console-authorize.ts' } })", "vitehub({ console: { authorize: './server/console-authorize.ts' } })"],
    ["vitehub({ console: { embed: true, mcp: true, origins: ['https://a.test'], signInPage: false, impersonation: true } })", "vitehub({ console: { impersonation: true } })"],
    ["vitehub({ console: { mcpClient: { servers: [] } }, host: 'node' })", "vitehub({ console: true, host: 'node' })"],
  ])("removes the Console options that left the app in %s", (from, to) => {
    const input = `import { vitehub } from 'vite-hub'\nexport default { plugins: [${from}] }\n`
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result).toMatchObject({ changed: true, code: input.replace(from, to), followUps: [] })
    expect(migrateViteHubOptions("vite.config.ts", result.code).changed).toBe(false)
  })

  it("removes console.pill in a Nuxt config", () => {
    const input = lines(
      "export default defineNuxtConfig({",
      "  modules: ['vite-hub/nuxt'],",
      "  vitehub: {",
      "    console: {",
      "      pill: true,",
      "      authorize: './server/console-authorize.ts',",
      "    },",
      "  },",
      "})",
    )
    const result = migrateViteHubOptions("nuxt.config.ts", input)
    expect(result.code).toBe(lines(
      "export default defineNuxtConfig({",
      "  modules: ['vite-hub/nuxt'],",
      "  vitehub: {",
      "    console: {",
      "      authorize: './server/console-authorize.ts',",
      "    },",
      "  },",
      "})",
    ))
    expect(result.notes).toEqual([expect.stringContaining("nuxt.config.ts: removed console.pill.")])
  })

  it("moves the Console journal options to agent.invocations", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ console: { retention: { days: 7 }, observations: false } })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code.replace(/\s+/g, "")).toBe("import{vitehub}from'vite-hub'exportdefault{plugins:[vitehub({console:true,agent:{invocations:{retention:{days:7},observations:false}},})]}")
    expect(result.followUps).toEqual([])
    expect(result.notes).toEqual(["vite.config.ts: moved console.retention, console.observations to agent.invocations."])
  })

  it("moves the Console journal options into an existing agent.invocations object", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ agent: { invocations: { mode: 'database' } }, console: { databaseUrl: 'file:x.db', authorize: './a.ts' } })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code.replace(/\s+/g, "")).toBe("import{vitehub}from'vite-hub'exportdefault{plugins:[vitehub({agent:{invocations:{mode:'database',databaseUrl:'file:x.db',}},console:{authorize:'./a.ts'}})]}")
  })

  it("reports the Console options that it cannot move", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ agent: { invocations: 'database' }, console: { retention: 7, auth: 'app' } })] }\n"
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps.map(followUp => followUp.message)).toEqual([
      expect.stringContaining("console.auth was removed"),
      expect.stringContaining("console.retention was removed. Move it to agent: { invocations: { retention } }"),
    ])
  })

  it("writes console: {} for an emptied console key in a Nuxt environment override", () => {
    const input = "export default defineNuxtConfig({ modules: ['vite-hub/nuxt'], vitehub: { console: { pill: false } }, $production: { vitehub: { console: { pill: false } } } })\n"
    const result = migrateViteHubOptions("nuxt.config.ts", input)
    expect(result.code.replace(/\s+/g, "")).toBe("exportdefaultdefineNuxtConfig({modules:['vite-hub/nuxt'],vitehub:{console:true},$production:{vitehub:{console:{}}}})")
  })

  it.each([
    ["a spread in the options", "export default { plugins: [vitehub({ ...shared, console: { retention: 7 } })] }\n"],
    ["a spread after agent", "export default { plugins: [vitehub({ agent: {}, ...shared, console: { retention: 7 } })] }\n"],
    ["a legacy top-level agent key", "export default { agent: { tools: [] }, plugins: [vitehub({ console: { retention: 7 } })] }\n"],
  ])("reports the Console journal options next to %s and inserts no second agent", (_, config) => {
    const result = migrateViteHubOptions("vite.config.ts", `import { vitehub } from 'vite-hub'\n${config}`)
    expect(result.code).toContain("console: { retention: 7 }")
    expect(result.code.match(/agent:/g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(result.followUps.map(followUp => followUp.message)).toContain("console.retention was removed. Move it to agent: { invocations: { retention } } in the vite-hub options by hand.")
  })

  it("keeps console.auth false and reports console.auth objects", () => {
    expect(migrateViteHubOptions("vite.config.ts", "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ console: { auth: false } })] }\n")).toMatchObject({ changed: false, followUps: [] })
    const result = migrateViteHubOptions("vite.config.ts", "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ console: { auth: { github: true } } })] }\n")
    expect(result.followUps.map(followUp => followUp.message)).toEqual([expect.stringContaining("console.auth was removed")])
  })

  it("leaves configs that use the current options unchanged", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ logs: true, env: { server: {} } })] }\n"
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

  it("migrates the vite-hub options of a file that nuxt.config.ts imports", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    await writeFile(join(cwd, "nuxt.config.ts"), lines(
      "import { createHostProfile } from './build/host-profile'",
      "const hostProfile = createHostProfile()",
      "export default defineNuxtConfig({ modules: hostProfile.modules, vitehub: hostProfile.vitehub })",
    ))
    await mkdir(join(cwd, "build"))
    const profile = (preset: string, sandbox: string) => lines(
      "export function createHostProfile() {",
      "  return {",
      "    modules: ['vite-hub/nuxt'],",
      "    vitehub: {",
      "      name: 'strata',",
      `      ${preset}: 'cloudflare' as const,`,
      `      ${sandbox}: true,`,
      "      schedule: true,",
      "    },",
      "  }",
      "}",
      "export const unrelated = { vitehub: { preset: 'react', devtools: true } }",
    )
    await writeFile(join(cwd, "build/host-profile.ts"), profile("preset", "sandbox"))
    const run = await runCodemod("vitehub-options", { cwd })
    expect(run.result.edits.map(edit => edit.path)).toEqual(["build/host-profile.ts"])
    expect(await readFile(join(cwd, "build/host-profile.ts"), "utf8")).toBe(profile("host", "sandboxTask"))
  })

  it("migrates a shared imported base and override only once", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    await writeFile(join(cwd, "nuxt.config.ts"), lines(
      "import { profile } from './profile'",
      "export default defineNuxtConfig({ vitehub: profile.vitehub, $development: profile.$development, $production: profile.$development })",
    ))
    await writeFile(join(cwd, "profile.ts"), lines(
      "export const profile = {",
      "  vitehub: { preset: 'cloudflare' },",
      "  $development: { vitehub: { observability: { service: 'app', logs: (readLogs(), true) } } },",
      "}",
    ))
    const { result } = await runCodemod("vitehub-options", { cwd, dryRun: true })
    expect(result.followUps).toEqual([])
    expect(result.edits[0]?.after).toBe(lines(
      "export const profile = {",
      "  vitehub: { host: 'cloudflare' },",
      "  $development: { vitehub: { observability: { service: 'app' }, logs: (readLogs(), true) } },",
      "}",
    ))
  })

  it("traces a Vite plugin argument and reports an opaque options expression", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    await writeFile(join(cwd, "vite.config.mts"), lines(
      "import { vitehub as hub } from 'vite-hub'",
      "import config, { opaque } from './profile.mjs'",
      "export default { plugins: [hub(config), hub(opaque())] }",
    ))
    await writeFile(join(cwd, "profile.mts"), lines(
      "export default { preset: 'cloudflare' } as const",
      "export const opaque = () => choose({ vitehub: { preset: 'react' } })",
    ))
    const { result } = await runCodemod("vitehub-options", { cwd, dryRun: true })
    expect(result.edits.map(edit => [edit.path, edit.after])).toEqual([["profile.mts", lines(
      "export default { host: 'cloudflare' } as const",
      "export const opaque = () => choose({ vitehub: { preset: 'react' } })",
    )]])
    expect(result.followUps).toEqual([expect.objectContaining({ file: "vite.config.mts", line: 3 })])
  })

  it("edits config files and reports renamed option types", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    await writeFile(join(cwd, "vite.config.ts"), "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { logs: true } })] }\n")
    await mkdir(join(cwd, "src"))
    await writeFile(join(cwd, "src/config.ts"), "import type { KVModuleOptions } from 'vite-hub'\nexport const kv: KVModuleOptions = false\n")
    const run = await runCodemod("vitehub-options", { cwd })
    expect(await readFile(join(cwd, "vite.config.ts"), "utf8")).toBe("import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ logs: true })] }\n")
    expect(formatReport(run)).toContain("src/config.ts:1 KVModuleOptions is now KVOptions.")
  })
})
