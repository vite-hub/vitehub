import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { browserChecks } from "./content-preview-browser.ts"
import { contentKey, linkFixtureModules, startBuiltServer } from "./content-preview-fixture.ts"

import type { AddressInfo } from "node:net"

const page = (title: string) => `---\ntitle: ${title}\n---\n[Next](/next)\n`

/** Sends the GitHub requests of the built server to the fake GitHub of the test, with the original URL in a header. */
const githubFetch = `
const target = process.env.FAKE_GITHUB_URL
const fetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  if (!/(^|\\.)github(usercontent)?\\.com$/.test(new URL(request.url).hostname)) return fetch(input, init)
  const headers = new Headers(request.headers)
  headers.set("x-fake-url", request.url)
  return fetch(target, { method: request.method, headers, body: request.body, duplex: "half" })
}
`

async function writeFiles(root: string, files: Array<[string, string]>): Promise<void> {
  for (const [path, source] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
}

/** The fields of a Nuxt page that tell where its links, data requests, and assets go. */
function read(html: string) {
  return {
    title: /<h1>([^<]*)<\/h1>/.exec(html)?.[1],
    route: /<p id="route">([^<]*)<\/p>/.exec(html)?.[1],
    markdown: /<a[^>]*href="([^"]*)"[^>]* id="markdown"/.exec(html)?.[1],
    next: /<a href="([^"]*)"[^>]* id="next"/.exec(html)?.[1],
    baseURL: /baseURL:"([^"]*)"/.exec(html)?.[1],
    assets: [...html.matchAll(/(?:src|href)="([^"]*\/_nuxt\/[^"]*)"/g)].map(match => match[1]!),
  }
}

describe("Content preview URLs in a built Nuxt app", () => {
  it("renders preview pages with the Nuxt base under the prefix, so links and data requests stay in the preview", async () => {
    const fake = createFakeGitHub({ owner: "acme", repo: "docs" })
    fake.commit("main", { "guide.md": page("Guide"), "next.md": page("Next") })
    fake.branch("feat/open", "main")
    fake.commit("feat/open", { "guide.md": page("Guide on feat/open"), "next.md": page("Next on feat/open") })
    const pull = fake.openPull("feat/open", "main", "Same repository")
    // A branch without a pull request is private: only a signed link opens it.
    fake.branch("feat/private", "main")
    fake.commit("feat/private", { "guide.md": page("Guide on feat/private"), "next.md": page("Next on feat/private") })
    const github = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(chunk as Buffer)
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value)
      const url = headers.get("x-fake-url")!
      headers.delete("x-fake-url")
      const response = await fake.fetch(new Request(url, { method: incoming.method, headers, ...chunks.length ? { body: Buffer.concat(chunks) } : {} }))
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    })
    await new Promise<void>(done => github.listen(0, "127.0.0.1", done))
    const root = await realpath(await mkdtemp(join(tmpdir(), "vitehub-content-preview-urls-nuxt-")))
    try {
      const nuxt = dirname(createRequire(import.meta.url).resolve("nuxt/package.json"))
      await linkFixtureModules(root, { nuxt })
      await writeFiles(root, [
        ["package.json", JSON.stringify({ private: true, type: "module" })],
        ["github-fetch.mjs", githubFetch],
        ["nuxt.config.ts", [
          `import viteHubNuxt from "vite-hub/nuxt"`,
          ``,
          `export default defineNuxtConfig({`,
          `  compatibilityDate: "2026-10-01",`,
          `  devtools: { enabled: false },`,
          `  modules: [[viteHubNuxt, { host: "node" }]],`,
          `  telemetry: false,`,
          `})`,
          ``,
        ].join("\n")],
        ["app/app.vue", `<template><NuxtPage /></template>\n`],
        ["app/pages/[...slug].vue", [
          `<script setup lang="ts">`,
          `const route = useRoute()`,
          `const NuxtLink = resolveComponent("NuxtLink")`,
          `const MarkdownLink = defineComponent({ props: ["node"], setup: props => () => h(NuxtLink, { ...props.node[1], id: "markdown" }, () => props.node[2]) })`,
          `const { data } = await useFetch("/api/page", { query: { path: route.path } })`,
          `</script>`,
          ``,
          `<template><main><h1>{{ data?.title }}</h1><p id="route">{{ route.path }}</p><NuxtLink id="next" to="/next">Next</NuxtLink><a v-if="data?.link" v-bind="data.link[1]" id="native">Next</a><MarkdownLink v-if="data?.link" :node="data.link" /></main></template>`,
          ``,
        ].join("\n")],
        ["server/content.ts", [
          `import { defineContent } from "vite-hub/content"`,
          `import { github } from "vite-hub/source"`,
          ``,
          `export default defineContent({ access: "public", sources: { docs: github({ repo: "acme/docs", ref: "main" }) }, previews: true, logger: false })`,
          ``,
        ].join("\n")],
        ["server/api/page.ts", [
          `import { getQuery } from "h3"`,
          `import content from "../content.ts"`,
          ``,
          `export default async (event) => {`,
          `  const page = await content.get(String(getQuery(event).path))`,
          `  const findLink = (value) => Array.isArray(value) ? value[0] === "a" ? value : value.map(findLink).find(Boolean) : value && typeof value === "object" ? Object.values(value).map(findLink).find(Boolean) : null`,
          `  return { title: page?.data.title ?? null, link: findLink(page) }`,
          `}`,
          ``,
        ].join("\n")],
        ["server/routes/sign.post.ts", `import content from "../content.ts"\n\nexport default async () => await content.sources.sign("feat/private", "docs")\n`],
      ])

      await promisify(execFile)(process.execPath, [join(nuxt, "bin/nuxt.mjs"), "build"], { cwd: root, env: { ...process.env, NODE_ENV: "production" } }).catch((error: Error & { stdout?: string }) => {
        throw new Error(`${error.message}\n${error.stdout ?? ""}`, { cause: error })
      })

      const server = await startBuiltServer(root, {
        FAKE_GITHUB_URL: `http://127.0.0.1:${(github.address() as AddressInfo).port}/`,
        NODE_ENV: "production",
        NODE_OPTIONS: `--import ${join(root, "github-fetch.mjs")}`,
        VITEHUB_CONTENT_KEY: contentKey,
        VITEHUB_GITHUB_TOKEN: "token",
      })
      try {
        const get = async (path: string) => {
          const response = await server.fetch(path)
          expect(response.status, path).toBe(200)
          return read(await response.text())
        }
        // The page renders at its production path. The Nuxt base is the preview prefix, so the client router reads the
        // same path, the link to the next page stays in the preview, and `$fetch` sends data requests to the prefix.
        // Build assets stay at the app root: they are the same files for every ref, and a host CDN serves them there.
        const preview = await get(`/pr/${pull}/guide`)
        expect(preview).toMatchObject({ title: "Guide on feat/open", route: "/guide", next: `/pr/${pull}/next`, baseURL: `/pr/${pull}/` })
        expect(preview.markdown).toBe(`/pr/${pull}/next`)
        expect(preview.assets.length).toBeGreaterThan(0)
        for (const asset of preview.assets) expect(asset).toMatch(/^\/_nuxt\//)
        // A data request from the client, under the prefix, reads the ref.
        const data = await server.fetch(`/pr/${pull}/api/page?path=/next`)
        expect(await data.json()).toMatchObject({ title: "Next on feat/open" })

        // Production pages keep the app base, also while preview requests run at the same time.
        const pages = await Promise.all(Array.from({ length: 12 }, async (_, index) => index % 2 ? { preview: true, page: await get(`/pr/${pull}/guide`) } : { preview: false, page: await get("/guide") }))
        for (const { preview, page } of pages) {
          expect(page).toMatchObject(preview
            ? { title: "Guide on feat/open", next: `/pr/${pull}/next`, baseURL: `/pr/${pull}/` }
            : { title: "Guide", next: "/next", baseURL: "/" })
        }

        // A signed link opens the private branch. Its token reaches the page's own requests as a cookie below the prefix.
        const prefix = "/tree/feat/private/-"
        const { token } = await (await server.fetch("/sign", { method: "POST" })).json() as { token: string }
        const signed = await server.fetch(`${prefix}/guide?vitehub-content-token=${token}`)
        expect(read(await signed.text())).toMatchObject({ title: "Guide on feat/private", next: `${prefix}/next`, baseURL: `${prefix}/` })
        const cookie = signed.headers.get("set-cookie")!.split(";", 1)[0]!
        expect(await (await server.fetch(`${prefix}/api/page?path=/next`, { headers: { cookie } })).json()).toMatchObject({ title: "Next on feat/private" })
        // Without the cookie, the request reaches the app unchanged, as for any unknown path, and the branch stays private.
        expect(await (await server.fetch(`${prefix}/api/page?path=/next`)).text()).not.toContain("on feat/private")

        if (browserChecks) {
          await expectBrowserStaysInPreview(server, `/pr/${pull}`, "", "feat/open")
          await expectBrowserStaysInPreview(server, prefix, `?vitehub-content-token=${token}`, "feat/private")
          console.info("Nuxt Chromium preview URL checks passed")
        }
      }
      finally {
        server.close()
      }
    }
    finally {
      github.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 300_000)
})

/** Chromium opens a preview, hydrates, and follows router and Markdown links under the prefix. */
async function expectBrowserStaysInPreview(server: { port: number }, prefix: string, query: string, branch: string): Promise<void> {
  const { chromium } = await import("playwright-core")
  const browser = await chromium.launch()
  try {
    const tab = await browser.newPage()
    const requests: string[] = []
    const errors: string[] = []
    tab.on("request", request => requests.push(new URL(request.url()).pathname))
    tab.on("pageerror", error => errors.push(error.message))
    tab.on("console", message => message.type() === "warning" || message.type() === "error" ? errors.push(message.text()) : undefined)
    const origin = `http://127.0.0.1:${server.port}`
    await tab.goto(`${origin}${prefix}/guide${query}`, { waitUntil: "networkidle" })
    expect(await tab.locator("h1").textContent()).toBe(`Guide on ${branch}`)
    expect(await tab.locator("#route").textContent()).toBe("/guide")
    expect(new URL(tab.url()).pathname).toBe(`${prefix}/guide`)
    await tab.locator("#next").click()
    await tab.waitForURL(`${origin}${prefix}/next`)
    await tab.locator("h1", { hasText: `Next on ${branch}` }).waitFor()
    await tab.goto(`${origin}${prefix}/guide${query}`, { waitUntil: "networkidle" })
    expect(await tab.locator("#native").getAttribute("href")).toBe(`${prefix}/next`)
    expect(await tab.locator("#markdown").getAttribute("href")).toBe(`${prefix}/next`)
    await tab.locator("#markdown").click()
    await tab.waitForURL(`${origin}${prefix}/next`)
    await tab.locator("h1", { hasText: `Next on ${branch}` }).waitFor()
    expect(await tab.locator("#route").textContent()).toBe("/next")
    expect(requests.filter(path => !path.startsWith(`${prefix}/`) && !path.startsWith("/_nuxt/"))).toEqual([])
    expect(requests).toContain(`${prefix}/api/page`)
    expect(errors).toEqual([])
  }
  finally {
    await browser.close()
  }
}
