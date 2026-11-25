import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expectJson, type PrimitiveEntry } from "./row.ts"
import { migrateDatabase } from "./storage.ts"

const placeholderD1Id = "00000000-0000-0000-0000-000000000000"

const cmsPresetTables = await readFile(join(import.meta.dirname, "cms-migration.sql"), "utf8")

async function readText(response: Response) {
  const body = await response.text()
  if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${body.slice(0, 2000)}`)
  return body
}

function expectEqual(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

export const content: PrimitiveEntry[] = [
  {
    id: "source",
    packages: ["@vite-hub/source"],
    files: {
      "primitive-source/intro.md": "# Notes from Source\n\nRead through glob.\n",
      "server/sources/primitive-notes.ts": `
        import { glob } from "vite-hub/source"

        export default glob({ cwd: "primitive-source", include: "**/*.md" })
      `,
      "server/api/primitives/source.get.ts": `
        import { defineEventHandler } from "nitro/h3"
        import { useSource } from "vite-hub/source"

        export default defineEventHandler(async () => {
          const reader = useSource("primitive-notes")
          return { keys: await reader.keys(), text: await reader.read("intro.md") }
        })
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/source"), { keys: ["intro.md"], text: "# Notes from Source\n\nRead through glob.\n" })
    },
  },
  {
    id: "content",
    packages: ["@vite-hub/content", "@vite-hub/source"],
    files: {
      "primitive-pages/intro.md": "# Hello from Content\n\nThis page came from a local Source.\n",
      "server/content.ts": `
        import { defineContent } from "vite-hub/content"
        import { glob } from "vite-hub/source"

        export default defineContent({
          sources: {
            pages: glob({ cwd: "primitive-pages", include: "**/*.md" }),
          },
        })
      `,
      "server/api/primitives/content.get.ts": `
        import { defineEventHandler } from "nitro/h3"
        import content from "../../content"

        export default defineEventHandler(async () => {
          const document = await content.get("/intro")
          return { path: document?.path ?? null, nodes: document?.nodes.slice(0, 2) ?? null }
        })
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/content"), {
        path: "/intro",
        nodes: [["h1", { id: "hello-from-content" }, "Hello from Content"], ["p", {}, "This page came from a local Source."]],
      })
    },
  },
  {
    id: "cms",
    packages: ["@vite-hub/blob", "@vite-hub/cms", "@vite-hub/content", "@vite-hub/database", "@vite-hub/source", "@vite-hub/workspace"],
    dependencies: { "drizzle-orm": "1.0.0-rc.6", zod: "4.6.7" },
    vitehub: target => target === "cloudflare"
      ? { blob: { bucketName: "nuxt-primitives" }, database: { databaseId: placeholderD1Id, databaseName: "nuxt-primitives", driver: "cloudflare" } }
      : { database: { migrateOnStart: true } },
    files: {
      "server/content.ts": `
        import { cms } from "vite-hub/cms"
        import { defineContent } from "vite-hub/content"
        import { documents } from "vite-hub/content/collections"
        import { glob } from "vite-hub/source"
        import { z } from "zod"

        export default defineContent({
          extends: cms,
          sources: {
            pages: glob({ cwd: "primitive-pages", include: "**/*.md" }),
          },
          collections: {
            posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }),
          },
          // The check has no signed-in user.
          authorize: () => true,
        })
      `,
      "server/databases/default/migrations/20261125000002_cms/migration.sql": cmsPresetTables,
      "server/api/primitives/cms.post.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import content from "../../content"

        export default defineEventHandler(async (event) => {
          const id = String(getQuery(event).id)
          const posts = content.collection("posts")
          const draft = await posts.save(id, { data: { title: \`Post \${id}\` }, body: \`# \${id}\\n\` })
          const before = await posts.get(id)
          const published = await content.publish({ collection: "posts", ids: [id] })
          return { draft: draft.data, publishedBefore: before !== null, published: published.documents }
        })
      `,
    },
    prepare: migrateDatabase,
    async probe({ fetch, mode }) {
      const id = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/cms?id=${id}`, { method: "POST" }), {
        draft: { title: `Post ${id}` },
        publishedBefore: false,
        published: [{ collection: "posts", id, change: "add" }],
      })
      const response = await fetch(`/api/content/get/posts/${id}`)
      const body = await readText(response)
      expectEqual((JSON.parse(body) as { data: unknown }).data, { title: `Post ${id}` }, `/api/content/get/posts/${id} data`)
    },
  },
  {
    id: "workspace",
    packages: ["@vite-hub/source", "@vite-hub/workspace"],
    files: {
      "primitive-workspace/intro.md": "# Workspace sample\n",
      "server/workspaces/primitive-drafts.ts": `
        import { defineWorkspace } from "vite-hub/workspace"
        import { glob } from "vite-hub/source"

        export default defineWorkspace({
          sources: {
            docs: glob({ cwd: "primitive-workspace", include: "**/*.md" }),
          },
        })
      `,
      "server/api/primitives/workspace.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { useWorkspace } from "vite-hub/workspace"

        export default defineEventHandler(async (event) => {
          const path = \`drafts/\${String(getQuery(event).key)}.md\`
          if (event.req.method === "PUT") {
            const workspace = useWorkspace("primitive-drafts", { mode: "write" })
            await workspace.fs.writeFile(path, await event.req.text(), { mediaType: "text/markdown" })
            const diff = await workspace.diff()
            return { added: diff.entries.filter(entry => entry.path === path).map(entry => entry.type) }
          }
          const workspace = useWorkspace("primitive-drafts")
          return {
            source: await workspace.fs.readFile("docs/intro.md"),
            draft: await workspace.fs.readFile(path),
            listed: (await workspace.fs.glob("**/*.md")).some(entry => entry.path === path),
          }
        })
      `,
    },
    async probe({ fetch, mode }) {
      const key = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/workspace?key=${key}`, { body: `# Draft ${key}\n`, method: "PUT" }), { added: ["added"] })
      await expectJson(await fetch(`/api/primitives/workspace?key=${key}`), { source: "# Workspace sample\n", draft: `# Draft ${key}\n`, listed: true })
    },
  },
  {
    id: "markdown-template",
    packages: ["@vite-hub/markdown-template"],
    files: {
      "server/utils/primitive-release.template.md": [
        "# Release {{ data.version }}",
        "",
        "::if{:value=\"data.status\" eq=\"ready\"}",
        "Status: {{ data.status }}",
        "::else",
        "Not ready.",
        "::",
        "::",
        "",
      ].join("\n"),
      "server/api/primitives/markdown-template.get.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import renderRelease from "../../utils/primitive-release.template.md"

        export default defineEventHandler(async (event) => {
          return { markdown: await renderRelease({ status: String(getQuery(event).status), version: "0.0.4 *beta*" }) }
        })
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/markdown-template?status=ready"), { markdown: "# Release 0.0.4 \\*beta\\*\n\nStatus: ready" })
      await expectJson(await fetch("/api/primitives/markdown-template?status=draft"), { markdown: "# Release 0.0.4 \\*beta\\*\n\nNot ready." })
    },
  },
  {
    id: "i18n",
    packages: ["@vite-hub/i18n"],
    vitehub: () => ({ i18n: { locales: ["en", "es"] } }),
    files: {
      "locales/es/segments/04/04a3600a9cf60152.json": `${JSON.stringify({
        hash: "04a3600a9cf60152",
        source: "Payment received",
        text: "Pago recibido",
        origin: "human",
        review: "edited",
        derived: "fresh",
        by: "vitehub",
        updatedAt: "2026-11-25T00:00:00.000Z",
      }, null, 2)}\n`,
      "server/api/primitives/i18n.get.ts": `
        import { defineEventHandler } from "nitro/h3"
        import { getLocale, t } from "vite-hub/i18n"

        export default defineEventHandler(() => ({ locale: getLocale(), message: t\`Payment received\` }))
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/i18n", { headers: { "accept-language": "es-MX,es;q=0.9,en;q=0.5" } }), { locale: "es", message: "Pago recibido" })
      await expectJson(await fetch("/api/primitives/i18n", { headers: { "accept-language": "es", cookie: "locale=en" } }), { locale: "en", message: "Payment received" })
    },
  },
  {
    id: "seo",
    packages: [],
    vitehub: () => ({ seo: { sitemap: true, robots: { disallow: ["/api/"] } } }),
    files: {
      "server/sitemap.ts": `
        import { defineSitemap } from "vite-hub/seo"

        export default defineSitemap(async () => [{ loc: "/primitive-products/one", lastmod: "2026-01-02" }])
      `,
    },
    async probe({ fetch }) {
      const sitemap = await readText(await fetch("/sitemap.xml"))
      const origin = new URL((await fetch("/sitemap.xml")).url).origin
      const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, entry]) => Object.fromEntries([...entry!.matchAll(/<(\w+)>([^<]*)<\/\1>/g)].map(([, name, value]) => [name, value])))
      const products = entries.filter(entry => entry.loc?.startsWith(`${origin}/primitive-products/`))
      expectEqual(products, [{ loc: `${origin}/primitive-products/one`, lastmod: "2026-01-02T00:00:00.000Z" }], "/sitemap.xml lists")
      const robots = await readText(await fetch("/robots.txt"))
      expectEqual(robots.trim().split("\n"), ["User-agent: *", "Disallow: /api/", "", `Sitemap: ${origin}/sitemap.xml`], "/robots.txt says")
    },
  },
  {
    id: "web-container",
    packages: ["@vite-hub/web-container"],
    vitehub: () => ({ webContainer: { routes: ["/primitive-playground/**"] } }),
    files: {
      "server/routes/primitive-playground/[...path].get.ts": `
        import { defineEventHandler } from "nitro/h3"

        export default defineEventHandler(() => new Response("<main>playground</main>", { headers: { "content-type": "text/html" } }))
      `,
      "server/api/primitives/web-container.get.ts": `
        import { defineEventHandler } from "nitro/h3"

        export default defineEventHandler(() => ({ isolated: false }))
      `,
    },
    async probe({ fetch }) {
      const isolation = (response: Response) => ({
        status: response.status,
        coep: response.headers.get("cross-origin-embedder-policy"),
        coop: response.headers.get("cross-origin-opener-policy"),
      })
      expectEqual(isolation(await fetch("/primitive-playground/editor")), { status: 200, coep: "credentialless", coop: "same-origin" }, "/primitive-playground/editor answers")
      expectEqual(isolation(await fetch("/api/primitives/web-container")), { status: 200, coep: null, coop: null }, "/api/primitives/web-container answers")
    },
  },
]
