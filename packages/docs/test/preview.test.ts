import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { H3 } from "h3"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { renderToString } from "vue/server-renderer"

import { createDocsManifest } from "../src/manifest.ts"
import * as navigation from "../src/navigation.ts"

import type { DocsContentDocument, DocsContentRuntime } from "../src/draft.ts"
import type { DocsPageResponse } from "../src/page.ts"

const fixtures = resolve(import.meta.dirname, "fixtures/content")
const getItem = vi.fn(async (key: string) => readFileSync(resolve(fixtures, key), "utf8"))

/** A Content runtime with one draft per id. `frame` is the document that a Console preview frame signs. */
const state: { active: boolean, frame?: { collection: string, id: string }, drafts: Map<string, DocsContentDocument> } = { active: false, drafts: new Map() }
const get = vi.fn(async (id: string) => state.drafts.get(id) ?? null)
const content: DocsContentRuntime = {
  preview: { active: () => state.active, frame: () => state.frame },
  resolve: async (path) => {
    const draft = [...state.drafts.values()].find(document => document.url === path)
    return draft ? { collection: "docs", id: draft.id } : null
  },
  collection: () => ({ get }),
}

vi.mock("#imports", async () => {
  const h3 = await import("h3")
  return { createError: h3.createError, defineEventHandler: h3.defineEventHandler, getRouterParam: h3.getRouterParam, setHeader: h3.setHeader, useStorage: () => ({ getItem }) }
})
vi.mock("#docs/manifest", async () => {
  const { createDocsManifest } = await import("../src/manifest.ts")
  return { default: createDocsManifest({ dir: fixtures, base: "/docs" }) }
})
vi.mock("#docs/content", () => ({ content }))

const { default: page } = await import("../src/runtime/server/page.ts")
const app = new H3().get("/api/_docs/page/**", page)

async function request(path: string): Promise<{ status: number, cacheControl: string | null, body: DocsPageResponse }> {
  const response = await app.fetch(new Request(`https://docs.example.com/api/_docs/page${path}.json`))
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() }
}

function text(response: DocsPageResponse): string {
  return JSON.stringify(response.document.nodes)
}

// Exercise the component's client-navigation branch with the real page endpoint, without building a Nuxt app.
const componentSource = readFileSync(resolve(import.meta.dirname, "../runtime/app/components/DocsPage.vue"), "utf8")
const componentScript = transpileModule(compileScript(parse(componentSource).descriptor, { id: "docs-page" }).content.replaceAll("import.meta.client", "true"), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
}).outputText

async function navigate(path: string) {
  const manifest = await createDocsManifest({ dir: fixtures, base: "/docs" })
  const mounted = new H3().get("/portal/api/_docs/page/**", page)
  const useFetch = vi.fn(async (url: string) => {
    const response = await mounted.fetch(new Request(`https://docs.example.com${url}`))
    return { data: vue.ref(response.ok ? await response.json() : null) }
  })
  const useSeoMeta = vi.fn()
  const exports: { default?: vue.Component } = {}
  runInNewContext(componentScript, {
    exports,
    require: (id: string) => {
      if (id === "vue") return vue
      if (id === "#docs/navigation") return navigation
      throw new Error(`Unexpected component import: ${id}`)
    },
    useRoute: () => ({ path }),
    useDocsManifest: () => manifest,
    useDocsConfig: () => ({ site: { url: "https://docs.example.com" }, appBase: "/portal/" }),
    useNuxtApp: () => ({ isHydrating: false }),
    useFetch,
    createError: (error: object) => Object.assign(new Error("Page not found"), error),
    useHead: vi.fn(),
    useSeoMeta,
  })
  const component = { ...exports.default, render: () => null }
  return { useFetch, useSeoMeta, render: () => renderToString(vue.createSSRApp(component)) }
}

const editedKv: DocsContentDocument = {
  id: "docs/kv/index",
  url: "/docs/kv",
  data: { "title": "KV draft", "navigation.title": "KV (draft)", "navigation.order": 1 },
  body: "# KV draft\n\nThe edited text.\n",
}

beforeEach(() => {
  vi.clearAllMocks()
  state.active = false
  state.frame = undefined
  state.drafts = new Map([[editedKv.id, editedKv]])
})

describe("page route with Content drafts", () => {
  it("renders the published file without a preview and never reads Content", async () => {
    const { status, cacheControl, body } = await request("/docs/kv")

    expect(status).toBe(200)
    expect(cacheControl).toBeNull()
    expect(body.page.sourceTitle).not.toBe("KV draft")
    expect(text(body)).not.toContain("The edited text.")
    expect(getItem).toHaveBeenCalledWith("docs/kv/index.md")
    expect(get).not.toHaveBeenCalled()
  })

  it("renders the draft with a preview cookie, parsed like a published page and not cached", async () => {
    state.active = true
    const { status, cacheControl, body } = await request("/docs/kv")

    expect(status).toBe(200)
    expect(cacheControl).toBe("private, no-store")
    expect(text(body)).toContain("The edited text.")
    expect(body.document.toc).toEqual([])
    // Dotted keys reach the page like the build reads them.
    expect(body.page).toMatchObject({ id: "index", path: "/docs/kv", file: "docs/kv/index.md", sourceTitle: "KV draft", title: "KV (draft)", order: 1 })
    expect(body.section).toBe("kv")
    expect(body.next).not.toBeNull()
    expect(getItem).not.toHaveBeenCalled()
  })

  it("renders the draft of the one document that a preview frame signs", async () => {
    state.frame = { collection: "docs", id: "docs/kv/index" }
    expect(text((await request("/docs/kv")).body)).toContain("The edited text.")

    // Other pages that the frame page loads stay published.
    const other = await request("/docs/kv/api")
    expect(other.cacheControl).toBeNull()
    expect(getItem).toHaveBeenCalledWith("docs/kv/api.md")
  })

  it("previews a new page that exists only as a draft", async () => {
    state.drafts.set("docs/kv/new-page", { id: "docs/kv/new-page", url: "/docs/kv/new-page", data: { title: "New page" }, body: "Only a draft.\n" })
    state.frame = { collection: "docs", id: "docs/kv/new-page" }
    const { status, body } = await request("/docs/kv/new-page")

    expect(status).toBe(200)
    expect(body.page).toMatchObject({ id: "new-page", path: "/docs/kv/new-page", file: "docs/kv/new-page.md", title: "New page" })
    expect(body.section).toBe("kv")
    expect(text(body)).toContain("Only a draft.")

    state.frame = undefined
    expect((await request("/docs/kv/new-page")).status).toBe(404)
  })

  it("loads a draft-only page during client navigation", async () => {
    state.active = true
    state.drafts.set("docs/kv/new-page", { id: "docs/kv/new-page", url: "/docs/kv/new-page", data: { title: "New page" }, body: "Only a draft.\n" })
    const { useFetch, useSeoMeta, render } = await navigate("/docs/kv/new-page")

    await expect(render()).resolves.toBeDefined()
    expect(useFetch).toHaveBeenCalledWith("/portal/api/_docs/page/docs/kv/new-page.json", { key: "docs:/docs/kv/new-page" })
    expect(get).toHaveBeenCalledWith("docs/kv/new-page")
    expect(useSeoMeta).toHaveBeenCalledWith(expect.objectContaining({ title: "New page" }))
  })

  it("returns a fatal 404 after requesting a missing page during client navigation", async () => {
    const { useFetch, render } = await navigate("/docs/kv/missing-page")

    await expect(render()).rejects.toMatchObject({ statusCode: 404, fatal: true })
    expect(useFetch).toHaveBeenCalledOnce()
  })

  it("keeps the published title while a draft's fields do not validate", async () => {
    state.active = true
    state.drafts.set(editedKv.id, { ...editedKv, data: { "title": 42, "navigation.order": "first" } })
    const published = (await request("/docs/kv/api")).body.page
    const { body } = await request("/docs/kv")

    expect(body.page.path).toBe("/docs/kv")
    expect(body.page.sourceTitle).not.toBe(42)
    expect(published.path).toBe("/docs/kv/api")
    expect(text(body)).toContain("The edited text.")
  })
})
