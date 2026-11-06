import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import vue from "@vitejs/plugin-vue"
import { build } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createLinguiConfig } from "../src/lingui.ts"
import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { extractMessages, inspectI18n } from "../src/inspect.ts"
import { hubI18n } from "../src/vite.ts"

const fixture = fileURLToPath(new URL("./fixtures/vue-app", import.meta.url))
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
let root: string

function linguiConfig() {
  return createLinguiConfig({ rootDir: root, locale: resolveI18nLocaleConfig({ locales: ["en", "es"] }), importBase: "@vite-hub/i18n" })
}

async function translate(file: string, translations: Record<string, string>): Promise<void> {
  let po = await readFile(file, "utf8")
  for (const [source, translation] of Object.entries(translations)) {
    po = po.replace(`msgid ${JSON.stringify(source)}\nmsgstr ""`, `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`)
  }
  await writeFile(file, po)
}

beforeAll(async () => {
  // Inside the package, so the copy resolves `vue` from the package dependencies.
  await mkdir(join(packageRoot, "test/.tmp"), { recursive: true })
  root = await mkdtemp(join(packageRoot, "test/.tmp/vue-app-"))
  await cp(fixture, root, { recursive: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("a Vue app with messages in templates and scripts", () => {
  it("extracts source-language messages from templates, Vue scripts, and modules", async () => {
    const statuses = await extractMessages(linguiConfig())
    const po = await readFile(join(root, "locales/es.po"), "utf8")
    expect(po).toContain(`msgid "Deploy your agent"`)
    expect(po).toContain(`msgid "Search agents"`)
    expect(po).toContain(`msgid "Hello <0>{0}</0>, read the <1>docs</1>."`)
    expect(po).toContain(`msgid "Deploy finished"`)
    expect(po).toContain(`msgid "{count, plural, one {# agent} other {# agents}}"`)
    expect(po).toContain("#: src/App.vue")
    expect(po).toContain("#: src/status.ts")
    expect(statuses).toEqual([
      expect.objectContaining({ locale: "en", source: true, messages: 5, missing: 0 }),
      expect.objectContaining({ locale: "es", source: false, messages: 5, translated: 0, missing: 5 }),
    ])
  })

  it("reports coverage after a translator fills the catalog", async () => {
    await translate(join(root, "locales/es.po"), {
      "Deploy your agent": "Despliega tu agente",
      "Search agents": "Buscar agentes",
      "Hello <0>{0}</0>, read the <1>docs</1>.": "Hola <0>{0}</0>, lee la <1>documentación</1>.",
      "{count, plural, one {# agent} other {# agents}}": "{count, plural, one {# agente} other {# agentes}}",
    })
    const statuses = await inspectI18n(linguiConfig())
    expect(statuses[1]).toMatchObject({ locale: "es", translated: 4, missing: 1 })
  })

  it("compiles messages to IDs and keeps the source text out of the app code", async () => {
    // Vitest sets NODE_ENV=test, and Vite drops message text only in production builds.
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    await build({
      root,
      logLevel: "silent",
      configFile: false,
      resolve: { alias: [{ find: /^@vite-hub\/i18n(\/.*)?$/, replacement: `${resolve(packageRoot, "dist")}$1` }] },
      plugins: [vue(), hubI18n({ locales: ["en", "es"], projectRoot: root, importBase: "@vite-hub/i18n" } as Parameters<typeof hubI18n>[0])],
      build: { minify: false, outDir: join(root, "dist") },
    }).finally(() => {
      process.env.NODE_ENV = nodeEnv
    })
    const assets = join(root, "dist/assets")
    const files = await readdir(assets)
    const chunks = await Promise.all(files.map(async file => ({ file, code: await readFile(join(assets, file), "utf8") })))
    const app = chunks.find(chunk => chunk.code.includes("createApp"))!
    const spanish = chunks.find(chunk => chunk.code.includes("Despliega tu agente"))
    expect(app.code).not.toContain("Deploy your agent")
    expect(app.code).not.toContain("Search agents")
    expect(app.code).not.toContain("Deploy finished")
    expect(app.code).toMatch(/id: "[\w+/-]{6}"/)
    expect(spanish, "the Spanish catalog is its own chunk").toBeDefined()
    expect(spanish!.file).not.toBe(app.file)
    // A message without a translation falls back to the source text instead of its ID.
    expect(spanish!.code).toContain("Deploy finished")
  })
})
