import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import vue from "@vitejs/plugin-vue"
import { build } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createI18nCliContributor } from "../src/cli.ts"
import { compileMessages } from "../src/catalogs.ts"
import { createLinguiConfig } from "../src/lingui.ts"
import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { inspectI18n } from "../src/inspect.ts"
import { messageId, readRecords, recordPath, writeRecord } from "../src/records.ts"
import { hubI18n } from "../src/vite.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { I18nManifest } from "../src/manifest.ts"

const fixture = fileURLToPath(new URL("./fixtures/vue-app", import.meta.url))
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
let root: string

function linguiConfig() {
  return createLinguiConfig({ rootDir: root, locale: resolveI18nLocaleConfig({ locales: ["en", "es"] }), importBase: "@vite-hub/i18n" })
}

async function cli(...args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const [namespace] = createI18nCliContributor(linguiConfig).namespaces!
  const feature = namespace!.features.find(entry => entry.name === args[0])!
  let stdout = ""
  let stderr = ""
  const context = {
    cwd: root,
    rootDir: root,
    env: {},
    stdout: { write: (chunk: string) => { stdout += chunk } },
    stderr: { write: (chunk: string) => { stderr += chunk } },
  } as unknown as ViteHubCliContext
  const code = await feature.run(args.slice(1), context) ?? 0
  return { code, stdout, stderr }
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
  it("reads source-language messages from templates, Vue scripts, and modules", async () => {
    const status = await inspectI18n(linguiConfig())
    const sources = Object.values(status.messages).map(message => message.message)
    expect(sources).toEqual(expect.arrayContaining([
      "Deploy your agent",
      "Search agents",
      "Hello <0>{0}</0>, read the <1>docs</1>.",
      "Deploy finished",
      "{count, plural, one {# agent} other {# agents}}",
      "Notice label",
      "Changes saved",
    ]))
    expect(status.messages[messageId("Deploy finished")]!.origins).toEqual([expect.stringMatching(/^src\/status\.ts:\d+$/)])
    expect(status.locales).toEqual([
      expect.objectContaining({ locale: "en", source: true, messages: 7, missing: 0 }),
      expect.objectContaining({ locale: "es", source: false, messages: 7, translated: 0, missing: 7, folder: "locales/es" }),
    ])
  })

  it("treats a cleared translation as missing and preserves its source fallback", async () => {
    const id = await writeRecord(join(root, "locales"), "es", { source: "Deploy finished", translation: "" })
    const status = await inspectI18n(linguiConfig())
    expect(status.locales[1]).toMatchObject({ translated: 0, missing: 7, problems: [] })
    const { records } = await readRecords(join(root, "locales"), "es")
    // The server keeps the source descriptor; the browser gets the source from its build catalog.
    expect(compileMessages(records)).not.toHaveProperty(id)
    expect(compileMessages(records, status.messages)[id]).toEqual(compileMessages({}, status.messages)[id])
  })

  it("exports a PO file and saves its translations as one record per message", async () => {
    const exported = await cli("export", "es", "--output", "es.po")
    expect(exported.code).toBe(0)
    let po = await readFile(join(root, "es.po"), "utf8")
    expect(po).toContain(`msgid "Deploy your agent"`)
    expect(po).toContain("#: src/App.vue:")
    const translations = {
      "Deploy your agent": "Despliega tu agente",
      "Search agents": "Buscar agentes",
      "Hello <0>{0}</0>, read the <1>docs</1>.": "Hola <0>{0}</0>, lee la <1>documentación</1>.",
      "{count, plural, one {# agent} other {# agents}}": "{count, plural, one {# agente} other {# agentes}}",
    }
    for (const [source, translation] of Object.entries(translations)) {
      po = po.replace(`msgid ${JSON.stringify(source)}\nmsgstr ""`, `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`)
    }
    await writeFile(join(root, "es.po"), po)

    const imported = await cli("import", "es", "es.po", "--json")
    expect(JSON.parse(imported.stdout)).toEqual({ locale: "es", saved: 4, unchanged: 0, fuzzy: 0 })
    const record = JSON.parse(await readFile(join(root, "locales", recordPath("es", messageId("Search agents"))), "utf8")) as Record<string, unknown>
    expect(record).toMatchObject({ source: "Search agents", translation: "Buscar agentes", review: "edited" })
    expect(JSON.parse((await cli("import", "es", "es.po", "--json")).stdout)).toMatchObject({ saved: 0, unchanged: 4 })

    const status = await inspectI18n(linguiConfig())
    expect(status.locales[1]).toMatchObject({ locale: "es", translated: 4, missing: 3, unused: 0 })
  })

  it("lists and prunes records whose message left the code", async () => {
    await writeRecord(join(root, "locales"), "es", { source: "Old button", translation: "Botón viejo" })
    expect((await cli("status")).stdout).toContain("1 unused")
    expect((await cli("prune")).stdout).toContain(`es  "Old button"`)
    expect((await inspectI18n(linguiConfig())).locales[1]!.unused).toBe(1)
    await cli("prune", "--yes")
    expect((await inspectI18n(linguiConfig())).locales[1]).toMatchObject({ translated: 4, unused: 0 })
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
    const english = chunks.find(chunk => chunk.file !== app.file && chunk.code.includes("Deploy your agent"))
    expect(app.code).not.toContain("Deploy your agent")
    expect(app.code).not.toContain("Search agents")
    expect(app.code).not.toContain("Deploy finished")
    expect(app.code).toContain(`id: "${messageId("Deploy your agent")}"`)
    // `<script setup>` imports the `t` macro, so the template `t` needs a runtime binding after the build removes it.
    expect(app.code).not.toContain("Changes saved")
    expect(app.code).toContain("translateInTemplate")
    expect(spanish, "the Spanish catalog is its own chunk").toBeDefined()
    expect(spanish!.file).not.toBe(app.file)
    // A message without a translation falls back to its source text, even though `extract` never ran.
    expect(spanish!.code).toContain("Deploy finished")
    expect(spanish!.code).toContain("Changes saved")
    expect(spanish!.code).not.toContain("__VITEHUB_I18N_CATALOG_")
    expect(english, "the source locale has a catalog with the source text").toBeDefined()

    const manifest = JSON.parse(await readFile(join(root, ".vitehub/i18n/manifest.json"), "utf8")) as I18nManifest
    expect(manifest.environments.client![messageId("Changes saved")]).toEqual({ message: "Changes saved", origins: [expect.stringMatching(/^src\/Notice\.vue:\d+$/)] })
    expect(Object.keys(manifest.environments.client!)).toHaveLength(7)
  })

  it("offers the old translation of a changed message as a fuzzy draft", async () => {
    const app = join(root, "src/App.vue")
    await writeFile(app, (await readFile(app, "utf8")).replace("t`Search agents`", "t`Search all agents`"))
    const status = await inspectI18n(linguiConfig())
    expect(status.locales[1]).toMatchObject({ translated: 3, missing: 4, changed: 1, unused: 1 })
    expect((await cli("status")).stdout).toContain("4 missing (1 changed), 1 unused")

    await cli("export", "es", "--output", "changed.po")
    const po = await readFile(join(root, "changed.po"), "utf8")
    expect(po).toContain(`#. Previous source: Search agents\n#: src/App.vue:`)
    expect(po).toMatch(/#, fuzzy\nmsgid "Search all agents"\nmsgstr "Buscar agentes"/)
    expect(JSON.parse((await cli("import", "es", "changed.po", "--json")).stdout)).toEqual({ locale: "es", saved: 0, unchanged: 3, fuzzy: 1 })

    await writeFile(join(root, "changed.po"), po.replace(/#, fuzzy\n(msgid "Search all agents")\nmsgstr "Buscar agentes"/, `$1\nmsgstr "Buscar todos los agentes"`))
    expect(JSON.parse((await cli("import", "es", "changed.po", "--json")).stdout)).toMatchObject({ saved: 1, fuzzy: 0 })
    expect((await inspectI18n(linguiConfig())).locales[1]).toMatchObject({ translated: 4, changed: 0, unused: 1 })
  })
})
