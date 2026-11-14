import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it, vi } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import * as navigation from "../src/navigation.ts"

const manifest = await createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" })
const source = readFileSync(resolve(import.meta.dirname, "../runtime/app/middleware/docs-layout.ts"), "utf8")

function route(fullPath: string, name = "docs-page") {
  return { path: fullPath.split(/[?#]/)[0]!, fullPath, name, matched: [{}], meta: {} as { layout?: string } }
}

type Middleware = (to: ReturnType<typeof route>, from: ReturnType<typeof route>) => unknown

// Compile the same client/server constant Nuxt supplies, while keeping the real manifest and navigation helpers.
function middleware(client = true, ownsApp = true, startLinks: string[] = []) {
  const script = transpileModule(source.replaceAll("import.meta.client", String(client)), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
  }).outputText
  const config = { app: { baseURL: "/" } }
  const navigateTo = vi.fn(() => false)
  const exports: { default?: Middleware } = {}
  runInNewContext(script, {
    exports,
    require: (id: string) => {
      if (id === "#docs/manifest") return { __esModule: true, default: manifest }
      if (id === "#docs/panels") return { __esModule: true, default: {} }
      if (id === "#docs/navigation") return navigation
      if (id === "#docs/shell") return { ownsApp }
      if (id === "#imports") return {
        defineNuxtRouteMiddleware: (callback: Middleware) => callback,
        isDocsStartLink: (_config: unknown, path: string) => startLinks.includes(path),
        navigateTo,
        useDocsConfig: () => ({}),
        useRuntimeConfig: () => config,
      }
      throw new Error(`Unexpected middleware import: ${id}`)
    },
  })
  return { run: exports.default!, navigateTo, config }
}

it.each(["/", "/portal/"])("loads server-owned paths under the runtime app base %s", async (baseURL) => {
  const { run, navigateTo, config } = middleware()
  config.app.baseURL = baseURL
  const path = "/play/?example=a%2Fb#code"
  expect(await run(route(path), route("/docs/kv"))).toBe(false)
  expect(navigateTo).toHaveBeenCalledWith(`${baseURL}play/?example=a%2Fb#code`, { external: true })
})

it.each([
  ["/docs/kv/configure", "docs-page", "docs"],
  ["/docs/kv/unpublished", "docs-page", "docs"],
  ["/about", "docs-page", "default"],
  ["/", "docs-page", "default"],
  ["/play/", "play", undefined],
])("keeps %s (%s) in the app", async (path, name, layout) => {
  const { run, navigateTo } = middleware()
  const to = route(path, name)
  await run(to, route("/docs/kv"))
  expect(navigateTo).not.toHaveBeenCalled()
  expect(to.meta.layout).toBe(layout)
})

it("does not reload initial, server, or same-path navigations", async () => {
  const client = middleware()
  await client.run(route("/missing"), { ...route("/"), matched: [] })
  await client.run(route("/missing?query=changed#anchor"), route("/missing"))
  expect(client.navigateTo).not.toHaveBeenCalled()
  const server = middleware(false)
  await server.run(route("/missing"), route("/docs/kv"))
  expect(server.navigateTo).not.toHaveBeenCalled()
})

it.each([false, true])("uses the article layout for the app owner and keeps start links in the docs shell (ownsApp: %s)", async (ownsApp) => {
  const { run, navigateTo } = middleware(true, ownsApp)
  for (const path of ["/about", "/"]) {
    const to = route(path)
    await run(to, route("/docs/kv"))
    expect(to.meta.layout).toBe(ownsApp ? "default" : "docs-article")
  }
  expect(navigateTo).not.toHaveBeenCalled()

  const start = middleware(true, ownsApp, ["/about"])
  const to = route("/about")
  await start.run(to, route("/docs/kv"))
  expect(to.meta.layout).toBe("docs")
  expect(start.navigateTo).not.toHaveBeenCalled()
})
