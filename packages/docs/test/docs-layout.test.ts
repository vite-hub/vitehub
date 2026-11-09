import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it, vi } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import * as navigation from "../src/navigation.ts"

const manifest = createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" })
const source = readFileSync(resolve(import.meta.dirname, "../runtime/app/middleware/docs-layout.ts"), "utf8")

function route(fullPath: string, name = "docs-page") {
  return { path: fullPath.split(/[?#]/)[0]!, fullPath, name, matched: [{}], meta: {} as { layout?: string } }
}

type Middleware = (to: ReturnType<typeof route>, from: ReturnType<typeof route>) => unknown

// Compile the same client/server constant Nuxt supplies, while keeping the real manifest and navigation helpers.
function middleware(client = true) {
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
      if (id === "#docs/navigation") return navigation
      if (id === "#imports") return {
        defineNuxtRouteMiddleware: (callback: Middleware) => callback,
        navigateTo,
        useRuntimeConfig: () => config,
      }
      throw new Error(`Unexpected middleware import: ${id}`)
    },
  })
  return { run: exports.default!, navigateTo, config }
}

it.each(["/", "/portal/"])("loads server-owned paths under the runtime app base %s", (baseURL) => {
  const { run, navigateTo, config } = middleware()
  config.app.baseURL = baseURL
  const path = "/play/?example=a%2Fb#code"
  expect(run(route(path), route("/docs/kv"))).toBe(false)
  expect(navigateTo).toHaveBeenCalledWith(`${baseURL}play/?example=a%2Fb#code`, { external: true })
})

it.each([
  ["/docs/kv/configure", "docs-page", "docs"],
  ["/docs/kv/unpublished", "docs-page", "docs"],
  ["/about", "docs-page", "default"],
  ["/", "docs-page", "default"],
  ["/play/", "play", undefined],
])("keeps %s (%s) in the app", (path, name, layout) => {
  const { run, navigateTo } = middleware()
  const to = route(path, name)
  run(to, route("/docs/kv"))
  expect(navigateTo).not.toHaveBeenCalled()
  expect(to.meta.layout).toBe(layout)
})

it("does not reload initial, server, or same-path navigations", () => {
  const client = middleware()
  client.run(route("/missing"), { ...route("/"), matched: [] })
  client.run(route("/missing?query=changed#anchor"), route("/missing"))
  expect(client.navigateTo).not.toHaveBeenCalled()
  const server = middleware(false)
  server.run(route("/missing"), route("/docs/kv"))
  expect(server.navigateTo).not.toHaveBeenCalled()
})
