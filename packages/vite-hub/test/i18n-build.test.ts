import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import vue from "@vitejs/plugin-vue"
import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject, runCli } from "./support/content-cms.ts"

const app = () => [vue(), vitehub({ i18n: { locales: ["en", "es"] }, preset: "node" })]

async function translate(file: string, translations: Record<string, string>): Promise<void> {
  let po = await readFile(file, "utf8")
  for (const [source, translation] of Object.entries(translations)) {
    const entry = `msgid ${JSON.stringify(source)}\nmsgstr ""`
    expect(po, `es.po has ${source}`).toContain(entry)
    po = po.replace(entry, `msgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(translation)}`)
  }
  await writeFile(file, po)
}

describe("i18n in a built Nitro 3 app", () => {
  it("extracts messages with the CLI, then serves each request in its own locale", async () => {
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

    const extract = await runCli(root, app(), ["i18n", "extract", "--json"])
    expect(extract.stderr).toBe("")
    expect(extract.exitCode).toBe(0)
    expect(JSON.parse(extract.stdout)).toEqual([
      expect.objectContaining({ locale: "en", messages: 3, source: true }),
      expect.objectContaining({ locale: "es", messages: 3, missing: 3 }),
    ])
    await translate(join(root, "locales/es.po"), {
      "Payment received": "Pago recibido",
      "Deploy your agent": "Despliega tu agente",
    })
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
})
