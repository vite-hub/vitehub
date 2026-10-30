import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { cachedRouteRules, contentKey, contentModule, contentRoutes, createHistoryDatabase, expectBoundedFrameUploads, expectFrameRedirects, expectPreviewBypassesCache, linkFixtureModules, nitro2FrameRoutes, nitro3FrameRoutes, postFrame, startBuiltServer } from "./content-preview-fixture.ts"

describe("Content preview in a built Nitro 3 app", () => {
  it("keeps preview requests out of the swr route cache, and follows preview frame redirects in the server", async () => {
    // The real path: on macOS the temporary directory is a symlink, and generated route paths must match Vite's root.
    const root = await realpath(await mkdtemp(join(tmpdir(), "vitehub-content-preview-nitro-")))
    try {
      await linkFixtureModules(root)
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      const files: Array<[string, string]> = [["content.ts", contentModule], ...contentRoutes("../content.ts"), ...nitro3FrameRoutes("../content.ts")]
      for (const [path, source] of files) {
        await mkdir(dirname(join(root, "server", path)), { recursive: true })
        await writeFile(join(root, "server", path), source)
      }
      const database = join(root, "history.sqlite")
      await createHistoryDatabase(database)

      const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        nitro: { routeRules: cachedRouteRules, serverDir: join(root, "server") },
        plugins: [nitro() as never, vitehub({ preset: "node" })],
        root,
      } as never)
      await builder.buildApp()

      const server = await startBuiltServer(root, { CONTENT_FIXTURE_DATABASE: database, NODE_ENV: "production", VITEHUB_CONTENT_KEY: contentKey })
      try {
        await expectPreviewBypassesCache(server, expect)
        await expectFrameRedirects(server, expect)
        await expectBoundedFrameUploads(server, expect)
      }
      finally {
        server.close()
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 180_000)
})

async function writeFiles(root: string, files: Array<[string, string]>): Promise<void> {
  for (const [path, source] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
}

describe("Content preview in a built Nuxt 4 app", () => {
  it("previews whole pages and server routes on Nitro 2, keeps them out of the swr route cache, and follows preview frame redirects", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vitehub-content-preview-nuxt-")))
    try {
      const nuxt = dirname(createRequire(import.meta.url).resolve("nuxt/package.json"))
      await linkFixtureModules(root, { nuxt })
      await writeFiles(root, [
        ["package.json", JSON.stringify({ private: true, type: "module" })],
        ["nuxt.config.ts", [
          `import viteHubNuxt from "vite-hub/nuxt"`,
          ``,
          `export default defineNuxtConfig({`,
          `  compatibilityDate: "2026-10-01",`,
          `  devtools: { enabled: false },`,
          `  modules: [[viteHubNuxt, { preset: "node" }]],`,
          `  routeRules: ${JSON.stringify({ ...cachedRouteRules, "/post": { swr: 60 }, "/old-post": { redirect: "/post" } })},`,
          `  telemetry: false,`,
          `})`,
          ``,
        ].join("\n")],
        ["app/app.vue", `<template><NuxtPage /></template>\n`],
        // A Nuxt page that reads Content during SSR through a server route, the way Nuxt pages usually do.
        ["app/pages/post.vue", [
          `<script setup lang="ts">`,
          `const { data } = await useFetch("/api/post")`,
          `</script>`,
          ``,
          `<template><h1>{{ data?.title }}</h1></template>`,
          ``,
        ].join("\n")],
        // A Nuxt page that redirects during SSR, the way a locale or sign-in middleware does.
        ["app/pages/redirecting.vue", [
          `<script setup lang="ts">`,
          `definePageMeta({ middleware: () => navigateTo("/post?from=middleware") })`,
          `</script>`,
          ``,
          `<template><p>never</p></template>`,
          ``,
        ].join("\n")],
        ["server/content.ts", contentModule],
        ...nitro2FrameRoutes("../content.ts").map(([path, source]): [string, string] => [`server/${path}`, source]),
        ["server/api/post.ts", `import { content } from "../content.ts"\n\nexport default defineEventHandler(async () => ({ title: (await content.collection("posts").get("hello"))?.data.title }))\n`],
        ...contentRoutes("../content.ts", code => `defineEventHandler(${code})`).map(([path, source]): [string, string] => [`server/${path}`, source]),
      ])
      const database = join(root, "history.sqlite")
      await createHistoryDatabase(database)

      await promisify(execFile)(process.execPath, [join(nuxt, "bin/nuxt.mjs"), "build"], { cwd: root, env: { ...process.env, NODE_ENV: "production" } })

      const server = await startBuiltServer(root, { CONTENT_FIXTURE_DATABASE: database, NODE_ENV: "production", VITEHUB_CONTENT_KEY: contentKey })
      try {
        await expectPreviewBypassesCache(server, expect)

        // Whole-page preview: the SSR render and its /api/post request read the draft, and the swr page cache
        // neither stores nor serves a preview render.
        const cookie = (await server.fetch("/preview", { method: "POST" })).headers.get("set-cookie")!.split(";", 1)[0]!
        const page = async (preview: boolean) => {
          const response = await server.fetch("/post", preview ? { headers: { cookie } } : undefined)
          return { title: /<h1>([^<]*)<\/h1>/.exec(await response.text())?.[1], cacheControl: response.headers.get("cache-control") }
        }
        expect(await page(true)).toEqual({ title: "Draft", cacheControl: "private, no-store" })
        expect((await page(false)).title).toBe("Published")
        expect((await page(true)).title).toBe("Draft")
        expect((await page(false)).title).toBe("Published")

        // Concurrent preview and public requests stay isolated.
        const reads = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
          const preview = index % 2 === 0
          const response = await server.fetch("/api/post", preview ? { headers: { cookie } } : undefined)
          return { preview, title: Reflect.get(Object(await response.json()), "title") }
        }))
        for (const read of reads) expect(read.title).toBe(read.preview ? "Draft" : "Published")

        // Preview frames on Nitro 2, whose redirects h3 v1 writes to the Node response directly.
        const token = await expectFrameRedirects(server, expect)
        // A route rule redirect and an SSR middleware redirect land on the Nuxt page, which reads Content through
        // /api/post, with the document on screen.
        for (const path of ["/old-post", "/redirecting"]) {
          const framed = await postFrame(server, path, token)
          expect(framed.status).toBe(200)
          expect(/<h1>([^<]*)<\/h1>/.exec(await framed.text())?.[1]).toBe("On screen")
        }
        expect((await page(false)).title).toBe("Published")
        await expectBoundedFrameUploads(server, expect)
      }
      finally {
        server.close()
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 300_000)
})
