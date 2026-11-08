import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NuxtConfig } from "nuxt/schema"

const files: Record<string, string> = {
  "content/index.md": "---\ntitle: Lumen\n---\nRead [the queue](/docs/queue).\n",
  "content/docs/queue/.navigation.yml": "title: Queue\nicon: i-lucide-list\norder: 1\ncategory: Compute\n",
  "content/docs/queue/index.md": "---\ntitle: Queue\n---\nQueue.\n",
  "content/docs/queue/diagnostics/index.md": "---\ntitle: Queue diagnostics\nnavigation.title: Diagnostics\nnavigation.panel: true\n---\nSee [QUEUE_DISABLED](/docs/queue/diagnostics/queue_disabled) and [QUEUE_MISSING_REGION](/docs/queue/diagnostics/queue_missing_region).\n",
  "content/docs/queue/diagnostics/queue_disabled.md": "---\ntitle: QUEUE_DISABLED\ndescription: Queue is disabled.\nseo.index: false\n---\nQueue is disabled in this runtime.\n",
  "content/docs/queue/diagnostics/queue_missing_region.md": "---\ntitle: QUEUE_MISSING_REGION\ndescription: Set a region.\n---\nSet `queue.region`.\n",
  "content/docs/kv/.navigation.yml": "title: KV\nicon: i-lucide-database\norder: 2\ncategory: Data\n",
  "content/docs/kv/index.md": "---\ntitle: KV\n---\nKV.\n",
  "content/docs/kv/diagnostics/index.md": "---\ntitle: KV diagnostics\nnavigation.title: Diagnostics\nnavigation.panel: true\n---\nKV codes.\n",
  "content/docs/blob/.navigation.yml": "title: Blob\nicon: i-lucide-box\norder: 3\ncategory: Data\n",
  "content/docs/blob/index.md": "---\ntitle: Blob\n---\nBlob.\n",
  "content/docs/start/.navigation.yml": "title: Start\nicon: i-lucide-rocket\norder: 0\ncategory: Start\n",
  "content/docs/start/index.md": "---\ntitle: Start\n---\nStart.\n",
  "nuxt.config.ts": "export default defineNuxtConfig({})\n",
}

it("renders `seo.index: false` pages on request with noindex, keeps them out of every index, and lists their title in search", async () => {
  // Inside the package, so the build resolves Tailwind and Nuxt UI as an installed app does.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-unindexed-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  let server: ReturnType<typeof spawn> | undefined
  try {
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), source)
    }
    const config: NuxtConfig = {
      dev: false,
      devtools: { enabled: false },
      modules: [[docs, { mcp: false, ogImage: false, categories: ["Start", "Compute", "Data"], site: { name: "Lumen", url: "https://lumen.example.com" } }]],
    }
    nuxt = await loadNuxt({ cwd: root, overrides: config, ready: true })
    // The link checker fails the build on a link to a page that was not built. The unindexed page is in the manifest.
    await build(nuxt)
    await nuxt.close()
    nuxt = undefined

    const output = (path: string) => join(root, ".output/public", path)
    // The panel Overview and the indexed code are prerendered. The unindexed code is not, and neither is its page data.
    expect(existsSync(output("docs/queue/diagnostics.html"))).toBe(true)
    expect(existsSync(output("docs/queue/diagnostics/queue_missing_region.html"))).toBe(true)
    expect(existsSync(output("docs/queue/diagnostics/queue_disabled.html"))).toBe(false)
    expect(existsSync(output("api/_docs/page/docs/queue/diagnostics/queue_disabled.json"))).toBe(false)

    const sitemap = await readFile(output("sitemap.xml"), "utf8")
    expect(sitemap).toContain("https://lumen.example.com/docs/queue/diagnostics</loc>")
    expect(sitemap).not.toContain("queue_disabled")
    // Search finds the unindexed code by its title and description, without its body.
    const search = JSON.parse(await readFile(output("api/_docs/search.json"), "utf8")) as { id: string, title: string, content: string }[]
    expect(search.map(record => record.id)).toContain("/docs/queue/diagnostics/queue_missing_region")
    expect(search.filter(record => record.id.startsWith("/docs/queue/diagnostics/queue_disabled"))).toEqual([
      expect.objectContaining({ id: "/docs/queue/diagnostics/queue_disabled", title: "QUEUE_DISABLED", titles: ["Queue"], level: 2, content: "Queue is disabled." }),
    ])

    // The section sidebar links to the panel once, not to its pages.
    const section = await readFile(output("docs/queue.html"), "utf8")
    expect(section).toMatch(/class="vh-docs-sidebar-link vh-docs-sidebar-panel-link"[^>]*href="\/docs\/queue\/diagnostics"|href="\/docs\/queue\/diagnostics"[^>]*class="vh-docs-sidebar-link vh-docs-sidebar-panel-link"/)
    expect(section).not.toContain("href=\"/docs/queue/diagnostics/queue_missing_region\"")

    const port = await freePort()
    server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NITRO_PORT: String(port), NITRO_HOST: "127.0.0.1" }, stdio: "ignore" })
    const html = await fetchWhenReady(`http://127.0.0.1:${port}/docs/queue/diagnostics/queue_disabled`)
    expect(html).toContain("<h1")
    expect(html).toContain("QUEUE_DISABLED")
    expect(html).toMatch(/<meta name="robots" content="noindex, follow"/)
    expect(html).not.toMatch(/<meta property="og:image"/)
    // Inside the panel: a link back to the section, and the rail opens the same panel in KV, but Blob has none.
    expect(html).toContain("vh-docs-sidebar-back")
    const rail = /<nav[^>]*class="[^"]*vh-primitive-rail[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ""
    expect(rail).toMatch(/href="\/docs\/kv\/diagnostics"/)
    expect(rail).toMatch(/href="\/docs\/blob"/)
    expect(rail).not.toMatch(/href="\/docs\/kv"/)

    const indexed = await readFile(output("docs/queue/diagnostics/queue_missing_region.html"), "utf8")
    expect(indexed).toMatch(/<meta name="robots" content="index, follow/)
  }
  finally {
    server?.kill()
    await nuxt?.close()
    await rm(root, { force: true, recursive: true })
  }
}, 600_000)

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => address && typeof address === "object" ? resolve(address.port) : reject(new Error("No port")))
    })
  })
}

async function fetchWhenReady(url: string): Promise<string> {
  const deadline = Date.now() + 30_000
  let failure: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.text()
      failure = new Error(`${url} answered ${response.status}`)
    }
    catch (error) {
      failure = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw failure
}
