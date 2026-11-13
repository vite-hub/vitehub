import { readdir, readFile, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import vue from "@vitejs/plugin-vue"
import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { contentDefinition, createProject, path, runCli } from "./support/content-cms.ts"

const app = () => [vue(), vitehub({ i18n: { locales: ["en", "es"] }, host: "node" })]

async function translatePo(file: string, translations: Record<string, string>): Promise<void> {
  let po = await readFile(file, "utf8")
  for (const [source, translation] of Object.entries(translations)) {
    const entry = `msgid ${JSON.stringify(source)}\nmsgstr ""`
    expect(po, `es.po has ${source}`).toContain(entry)
    po = po.replace(entry, `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`)
  }
  await writeFile(file, po)
}

describe("i18n in a built Nitro 3 app", () => {
  it("translates with the CLI, then serves each request in its own locale", async () => {
    const root = await createProject({
      "index.html": "<!doctype html><html lang=\"en\"><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
      "package.json": JSON.stringify({ name: "i18n-build", private: true, type: "module" }),
      "src/main.ts": [
        "import { createApp } from 'vue'",
        "import { createI18n } from 'vite-hub/i18n/vue'",
        "import App from './App.vue'",
        "",
        "createApp(App).use(await createI18n()).mount('#app')",
        "",
      ].join("\n"),
      "src/App.vue": "<template><h1>{{ t`Deploy your agent` }}</h1></template>\n",
      // The delay lets concurrent requests interleave, so a shared locale would leak between them.
      "server/routes/greeting.ts": [
        "import { getLocale, plural, t } from 'vite-hub/i18n'",
        "",
        "export default async (event) => {",
        "  const count = Number(new URL(event.req.url).searchParams.get('count') ?? 1)",
        "  await new Promise(resolve => setTimeout(resolve, Math.random() * 20))",
        "  return { locale: getLocale(), message: t`Payment received`, items: plural(count, { one: '# item', other: '# items' }) }",
        "}",
        "",
      ].join("\n"),
      "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
    })

    const before = await runCli(root, app(), ["i18n", "status", "--json"])
    expect(before.stderr).toBe("")
    expect(before.exitCode).toBe(0)
    expect(JSON.parse(before.stdout)).toEqual([
      expect.objectContaining({ locale: "en", messages: 3, source: true }),
      expect.objectContaining({ locale: "es", messages: 3, missing: 3 }),
    ])
    const exported = await runCli(root, app(), ["i18n", "export", "es", "--output", "es.po"])
    expect(exported.exitCode).toBe(0)
    await translatePo(join(root, "es.po"), {
      "Payment received": "Pago recibido",
      "Deploy your agent": "Despliega tu agente",
    })
    const imported = await runCli(root, app(), ["i18n", "import", "es", "es.po", "--json"])
    expect(JSON.parse(imported.stdout)).toEqual({ locale: "es", saved: 2, unchanged: 0, fuzzy: 0, refused: [] })
    const status = await runCli(root, app(), ["i18n", "status", "--json"])
    expect(JSON.parse(status.stdout)[1]).toMatchObject({ locale: "es", translated: 2, missing: 1 })

    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    // Vitest sets NODE_ENV=test, and the build drops message text only in production.
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [app(), nitro() as never], root } as never)
      await builder.buildApp()
    }
    finally {
      process.env.NODE_ENV = nodeEnv
    }

    const assets = join(root, ".output/public/assets")
    const client = await Promise.all((await readdir(assets)).map(file => readFile(join(assets, file), "utf8")))
    expect(client.some(code => code.includes("Despliega tu agente")), "the Spanish catalog ships to the client").toBe(true)
    expect(client.find(code => code.includes("createApp")), "the app code has message IDs, not text").not.toContain("Deploy your agent")
    expect(client.some(code => code.includes("Pago recibido")), "translations of server-only messages stay on the server").toBe(false)

    const server = await startBuiltServer(root, {})
    try {
      type Greeting = { locale: string, message: string, items: string }
      const greet = async (headers: Record<string, string>, count = 1) => await (await server.fetch(`/greeting?count=${count}`, { headers })).json() as Greeting
      expect(await greet({ "accept-language": "es-MX,es;q=0.9,en;q=0.5" }, 2)).toEqual({ locale: "es", message: "Pago recibido", items: "2 items" })
      expect(await greet({ "accept-language": "fr, en;q=0.8" })).toEqual({ locale: "en", message: "Payment received", items: "1 item" })
      // A cookie that `setLocale()` wrote wins over the browser languages.
      expect(await greet({ "accept-language": "es", "cookie": "theme=dark; locale=en" })).toMatchObject({ locale: "en", message: "Payment received" })

      const requests = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? "es" : "en")
      const results = await Promise.all(requests.map(locale => greet({ "accept-language": locale })))
      expect(results.map(result => result.locale)).toEqual(requests)
      expect(results.map(result => result.message)).toEqual(requests.map(locale => locale === "es" ? "Pago recibido" : "Payment received"))
    }
    finally {
      server.close()
    }
  }, 120_000)

  it("serves a translation that a Workspace publishes, without a rebuild", async () => {
    const live = () => [vue(), vitehub({ i18n: { locales: ["en", "es"], workspace: "content" }, host: "node" })]
    const root = await createProject({
      "index.html": "<!doctype html><html lang=\"en\"><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
      "package.json": JSON.stringify({ name: "i18n-workspace", private: true, type: "module" }),
      "src/main.ts": "import { createApp } from 'vue'\nimport { createI18n } from 'vite-hub/i18n/vue'\nimport App from './App.vue'\n\ncreateApp(App).use(await createI18n()).mount('#app')\n",
      "src/App.vue": "<template><h1>{{ t`Deploy your agent` }}</h1></template>\n",
      // The cms preset adds the `content` Workspace, with retained history in Blob and Database.
      "server/content.ts": contentDefinition,
      "server/routes/greeting.ts": "import { t } from 'vite-hub/i18n'\n\nexport default () => ({ message: t`Payment received` })\n",
      "server/routes/translate.post.ts": [
        "import { useTranslations } from 'vite-hub/i18n/server'",
        "",
        "export default async () => {",
        "  const translations = useTranslations()",
        "  const [, missing] = await translations.missing('es')",
        "  await translations.save({ locale: 'es', source: 'Payment received', translation: 'Pago hecho', by: 'test' })",
        "  await translations.save({ locale: 'es', source: 'Deploy your agent', translation: 'Despliega tu agente' })",
        "  const draft = await translations.revision()",
        "  const status = await translations.status()",
        "  return { draft, missing, status, ...await translations.publish({ message: 'Spanish' }) }",
        "}",
        "",
      ].join("\n"),
      "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
    })
    // The libSQL file and the Blob folder are relative to the working directory, as when the app runs.
    process.chdir(root)
    process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}${delimiter}${path}`
    for (const command of [["database", "generate"], ["database", "migrate"]]) {
      const result = await runCli(root, live(), command)
      expect(result.stderr, command.join(" ")).toBe("")
      expect(result.exitCode).toBe(0)
    }

    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: [live(), nitro() as never], root } as never)
      await builder.buildApp()
    }
    finally {
      process.env.NODE_ENV = nodeEnv
    }

    const server = await startBuiltServer(root, {})
    try {
      const spanish = { "accept-language": "es" }
      const catalog = (headers: Record<string, string> = {}) => server.fetch("/_vitehub/i18n/es.json", { headers })
      expect(await (await server.fetch("/greeting", { headers: spanish })).json()).toEqual({ message: "Payment received" })
      expect(await (await catalog()).json()).toEqual({ revision: "build", messages: {} })

      type Published = { draft: string, revision: string, published: number, missing: { total: number, items: Array<{ source: string, origins: string[] }> }, status: unknown[] }
      const published = await (await server.fetch("/translate", { method: "POST" })).json() as Published
      expect(published).toMatchObject({ draft: "build", published: 2 })
      // The build embedded every message of the browser and the server, so the server knows what is missing.
      expect(published.missing.total).toBe(2)
      expect(published.missing.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "Deploy your agent", origins: [expect.stringMatching(/^src\/App\.vue:\d+$/)] }),
        expect.objectContaining({ source: "Payment received", origins: [expect.stringMatching(/^server\/routes\/greeting\.ts:\d+$/)] }),
      ]))
      expect(published.status).toEqual([{ locale: "es", messages: 2, published: 0, drafted: 2, missing: 0 }])
      expect(await (await server.fetch("/greeting", { headers: spanish })).json()).toEqual({ message: "Pago hecho" })

      const response = await catalog()
      expect(response.headers.get("etag")).toBe(`"${published.revision}"`)
      const body = await response.json() as { revision: string, messages: Record<string, unknown> }
      expect(body.revision).toBe(published.revision)
      // `Payment received` is only in server code, so its translation stays on the server.
      expect(Object.values(body.messages)).toEqual([["Despliega tu agente"]])
      expect((await catalog({ "if-none-match": `"${published.revision}"` })).status).toBe(304)
    }
    finally {
      server.close()
    }
  }, 180_000)
})
