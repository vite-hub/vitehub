import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NitroConfig } from "nitropack"
import type { Nuxt, NuxtConfig } from "nuxt/schema"

interface LinkReport { route: string, reports: Array<{ link: string, error: Array<{ name: string }>, warning: Array<{ name: string }> }> }

async function buildSite(links: string, routeRules: NonNullable<NuxtConfig["routeRules"]>, moduleRules: NonNullable<NuxtConfig["routeRules"]> = {}, { nitroRules = {}, buildApp = true }: { nitroRules?: NitroConfig["routeRules"], buildApp?: boolean } = {}) {
  // Inside the package, so the build resolves Tailwind and Nuxt UI as an installed app does.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-redirects-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    await mkdir(join(root, "content/docs/guide"), { recursive: true })
    await writeFile(join(root, "content/index.md"), `---\ntitle: Lumen\n---\n${links}\n`)
    await writeFile(join(root, "content/docs/guide/index.md"), "---\ntitle: Guide\n---\nHello\n")
    await writeFile(join(root, "content/docs/guide/install.md"), "---\ntitle: Install\n---\n## Install\n\nInstall\n")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    const config: NuxtConfig & { linkChecker: object } = {
      dev: false,
      devtools: { enabled: false },
      // A module after the docs module adds its own redirect rules, as a redirect table module does.
      modules: [[docs, { mcp: false, ogImage: false, site: { name: "Lumen", url: "https://lumen.example.com" } }], (_options: unknown, nuxt: { options: { routeRules?: NuxtConfig["routeRules"] }, hook: Nuxt["hook"] }) => {
        nuxt.options.routeRules = { ...moduleRules, ...nuxt.options.routeRules }
        Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroConfig) => {
          nitro.routeRules = { ...nitroRules, ...nitro.routeRules }
        }])
      }],
      linkChecker: { report: { json: true, storage: join(root, "report") } },
      routeRules,
    }
    nuxt = await loadNuxt({ cwd: root, overrides: Object.assign(config, { _generate: true }), ready: true })
    if (buildApp) await build(nuxt)
    const report = join(root, "report/link-checker-report.json")
    return existsSync(report) ? JSON.parse(await readFile(report, "utf8")) as LinkReport[] : []
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}

it("passes links to redirect route rules that lead to a page", async () => {
  const report = await buildSite(
    "Read [the old guide](/docs/old), [its slash form](/docs/old/), [the old install](/docs/setup), [a moved heading](/docs/hashed), [its Markdown](/raw/docs/old.md), and [a guide on another site](/docs/chain).",
    {
      "/docs/old": { redirect: "/docs/guide" },
      "/docs/old/": { redirect: "/docs/guide" },
      "/docs/hashed": { redirect: { to: "/docs/guide/install#install" } },
      "/raw/docs/old.md": { redirect: "/raw/docs/guide.md" },
      "/docs/chain": { redirect: "/docs/alias" },
      "/docs/alias": { redirect: "https://example.com/docs" },
    },
    { "/docs/setup": { redirect: "/docs/guide/install" } },
  )
  // Without the docs module, each link reports "Should not redirect".
  expect(report.flatMap(route => route.reports.map(entry => [entry.link, [...entry.error, ...entry.warning].map(issue => issue.name)]))).toEqual([])
}, 180_000)

it("stops the build on a redirect to a docs page that does not exist", async () => {
  await expect(buildSite("Read [the old guide](/docs/old).", { "/docs/old": { redirect: "/docs/nowhere" } })).rejects.toThrow(
    "The redirect from /docs/old goes to /docs/nowhere, which is not a docs page. Point it to a page, or remove the route rule.",
  )
}, 180_000)

it("stops the build on a redirect that hides a docs page", async () => {
  await expect(buildSite("Read [install](/docs/guide/install).", {}, { "/docs/guide/install": { redirect: "/docs/guide" } })).rejects.toThrow(
    "The redirect from /docs/guide/install hides the page docs/guide/install.md. Remove the route rule, or move the page.",
  )
}, 180_000)

it.each<{ name: string, rules: NonNullable<NitroConfig["routeRules"]>, problem: string }>([
  {
    name: "a missing docs destination",
    rules: { "/docs/old": { redirect: "/docs/nowhere" } },
    problem: "The redirect from /docs/old goes to /docs/nowhere, which is not a docs page.",
  },
  {
    name: "a hidden docs page",
    rules: { "/docs/guide/install": { redirect: "/docs/guide" } },
    problem: "The redirect from /docs/guide/install hides the page docs/guide/install.md.",
  },
  {
    name: "a redirect cycle",
    rules: { "/docs/old": { redirect: "/docs/alias" }, "/docs/alias": { redirect: "/docs/old" } },
    problem: "The redirect from /docs/old comes back to /docs/old and never reaches a page.",
  },
])("rejects $name from a later module's Nitro config hook", async ({ rules, problem }) => {
  // Validation happens while initializing Nitro, before compiling the production app or crawling links.
  await expect(buildSite("", {}, {}, { nitroRules: rules, buildApp: false })).rejects.toThrow(problem)
}, 30_000)

it("accepts a chain completed by a later module's Nitro config hook", async () => {
  await expect(buildSite("", { "/docs/old": { redirect: "/docs/alias" } }, {}, {
    nitroRules: { "/docs/alias": { redirect: "https://example.com/docs" } },
    buildApp: false,
  })).resolves.toEqual([])
}, 30_000)
