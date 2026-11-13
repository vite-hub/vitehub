import { comarkContent, type ContentPlugin } from "comark-content"
import sqlite from "comark-content/database/sqlite-node"
import json from "comark-content/plugins/json"
import media from "comark-content/plugins/media"
import sqliteFullTextSearch from "comark-content/plugins/sqlite-full-text-search"
import comarkUi from "comark-ui/html"
import { setTimeout as delay } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import { clearSources, createSource, defineSource, github, registerSources, useSource } from "@vite-hub/source"
import type { SourceName } from "@vite-hub/source"

import { contentSource, defineContent, defineContentHandler, renderContentHtml } from "../src/index.ts"
import type { ContentAuthorize } from "../src/index.ts"

afterEach(clearSources)

it("accepts Web Requests from another realm", async () => {
  const request = runInNewContext(`new Request("https://example.test/content", {
    method: "POST",
    body: "hello",
  })`, { Request }) as Request
  const handler = defineContentHandler({ handler: async input => new Response(await input.text()) })
  const response = await handler.fetch(request)
  expect(response.status).toBe(200)
  await expect(response.text()).resolves.toBe("hello")
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function testPlugin(name: string, setup: ContentPlugin["setup"]): ContentPlugin {
  return { name, setup }
}

describe("contentSource", () => {
  it("gives Comark Content parsed documents, navigation, cache, and runtime handling", async () => {
    const docs = defineSource({
      name: "docs",
      async getKeys() {
        return ["document_1"]
      },
      async getItem() {
        return {
          content: "---\ntitle: Introduction\n---\n# Start\n\nRuntime content.\n",
          key: "document_1",
          path: "guide/index.md",
        }
      },
    })

    const content = defineContent({
      plugins: [sqliteFullTextSearch({ database: sqlite() })],
      sources: { docs },
    })

    await expect(content.list("docs")).resolves.toEqual([
      expect.objectContaining({
        data: { title: "Introduction" },
        path: "/guide",
      }),
    ])
    await expect(content.get("/guide")).resolves.toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([expect.any(Array)]),
        path: "/guide",
      }),
    )
    await expect(content.navigation(["docs"])).resolves.toEqual([expect.objectContaining({ path: "/guide", title: "Introduction" })])
    await expect(content.search(["docs"], "Runtime")).resolves.toEqual([
      expect.objectContaining({
        content: "Runtime content.",
        id: "/guide#start",
        source: "docs",
      }),
    ])

    const response = await content.handler(new Request("https://example.test/api/content/get/guide"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ path: "/guide" }))
    await expect(content.cache.keys("docs")).resolves.toEqual(["docs:guide/index.md"])
  })

  it("parses Comark UI blocks by default and lets callers replace a preset plugin", async () => {
    const source = {
      keys: () => ["index.md"],
      getItem: () => "> [!NOTE]\n> Read this.\n",
      getItemRaw: () => "> [!NOTE]\n> Read this.\n",
    }
    const content = defineContent({ sources: { docs: source } })
    expect((await content.get("/"))?.nodes).toEqual(expect.arrayContaining([
      expect.arrayContaining(["github-callout", expect.objectContaining({ type: "note" })]),
    ]))
    const custom = defineContent({
      sources: { docs: source },
      markdown: { plugins: [{ name: "alert", post: state => { state.tree.nodes = [["p", {}, "Custom callout"]] } }] },
    })
    expect((await custom.get("/"))?.nodes).toEqual(expect.arrayContaining([["p", {}, "Custom callout"]]))
  })

  it("parses with the caller's plugins alone when the preset is off", async () => {
    const markdown = "A [link](https://example.com).\n"
    const source = { keys: () => ["index.md"], getItem: () => markdown, getItemRaw: () => markdown }
    const preset = defineContent({ source })
    const own = defineContent({ source, markdown: { preset: false, plugins: [] } })
    try {
      expect(JSON.stringify((await preset.get("/"))?.nodes)).toContain("chip")
      expect((await own.get("/"))?.nodes).toEqual([["p", {}, "A ", ["a", { href: "https://example.com" }, "link"], "."]])
    } finally {
      await preset.dispose()
      await own.dispose()
    }
  })

  it("leaves HTML-only quiz processing opt-in for a custom renderer", async () => {
    const markdown = "::question\nChoose one.\n\n- [x] Yes\n- [ ] No\n::\n"
    const source = { keys: () => ["index.md"], getItem: () => markdown, getItemRaw: () => markdown }
    const content = defineContent({ source })
    const custom = defineContent({ source, markdown: { plugins: comarkUi().plugins.filter(plugin => plugin.name === "comark-quiz") } })
    try {
      const page = await content.get("/")
      const question = page?.nodes.find(node => Array.isArray(node) && node[0] === "question")
      expect(question?.[1]).not.toHaveProperty("number")
      const customPage = await custom.get("/")
      const customQuestion = customPage?.nodes.find(node => Array.isArray(node) && node[0] === "question")
      expect(customQuestion?.[1]).toHaveProperty("number", "1")
    } finally {
      await content.dispose()
      await custom.dispose()
    }
  })

  it("accepts source name arrays from another JavaScript realm", async () => {
    const content = defineContent({
      sources: {
        docs: {
          keys: () => ["index.md"],
          getItem: () => "# Docs",
          getItemRaw: () => "# Docs",
        },
      },
    })
    const names = runInNewContext("['docs']") as string[]

    await expect(content.list(names)).resolves.toEqual([expect.objectContaining({ path: "/" })])
  })

  it("routes named-source cache and plugin operations across multiple instances", async () => {
    function source(title: string) {
      return {
        keys: () => ["index.md"],
        getItem: () => `# ${title}`,
        getItemRaw: () => title,
      }
    }
    const content = defineContent({
      plugins: [
        media(),
        { name: "custom", setup: () => ({ greeting: () => "hello" }) },
      ],
      sources: {
        first: contentSource(source("First"), { prefix: "/first" }),
        second: contentSource(source("Second"), { prefix: "/second" }),
      },
    })
    await content.init()
    expect(content.greeting()).toBe("hello")
    expect(content.media.get).toBeTypeOf("function")
    expect(content.getSource("second")?.prefix).toBe("/second")
    expect(await content.list("second")).toEqual([expect.objectContaining({ path: "/second" })])
    await content.cache.refresh("second")
    expect(await content.cache.keys()).toEqual(["first:index.md", "second:index.md"])
    expect(await content.cache.get("second:index.md")).toMatchObject({ path: "/second" })
    await content.cache.invalidate("second:index.md")
    expect(await content.cache.get("second:index.md")).toBeNull()
    expect(await content.get("/second")).toMatchObject({ path: "/second" })
    await content.dispose()
  })

  it("preserves plugin methods whose names are inherited by the runtime object", () => {
    const plugin: ContentPlugin<{ constructor: () => string }> = {
      name: "prototype-key",
      setup: () => ({ constructor: () => "plugin-constructor" }),
    }
    const content = defineContent({
      plugins: [plugin],
      source: {
        keys: () => [],
        getItem: () => "",
        getItemRaw: () => "",
      },
    })

    expect((content as unknown as { constructor: () => string }).constructor()).toBe("plugin-constructor")
  })

  it.each(["definition", "name", "factory"] as const)("uses a fresh reader on refresh with a %s", async (input) => {
    let revision = 1
    const prepared: string[] = []
    const docs = defineSource({
      name: "live",
      async resolveRevision() {
        return { id: String(revision), immutable: true }
      },
      async prepare(ctx) {
        prepared.push(ctx.revision!.id)
      },
      async getKeys() {
        return ["index.md"]
      },
      async getItem(_key, ctx) {
        return {
          content: `# Revision ${ctx.revision?.id}`,
          key: "index.md",
        }
      },
    })
    registerSources({ docs })
    const source = input === "definition" ? docs : input === "name" ? "docs" : () => createSource(docs)
    const content = defineContent({ sources: { live: source } })
    const initial = await content.get("/", { fresh: true })
    expect(JSON.stringify(initial?.nodes)).toContain("Revision 1")

    revision = 2
    await content.cache.refresh("live")

    const refreshed = await content.get("/")
    expect(JSON.stringify(refreshed?.nodes)).toContain("Revision 2")
    expect(prepared).toContain("1")
    expect(prepared.at(-1)).toBe("2")
  })

  it("reads one known document on get instead of every Source item", async () => {
    const files = new Map(Array.from({ length: 50 }, (_, index) => [`page-${index}.md`, `# Page ${index}\n`]))
    const reads: string[] = []
    let listings = 0
    const docs = defineSource({
      name: "docs",
      async getKeys() {
        listings++
        return [...files.keys()]
      },
      async getItem(key) {
        reads.push(key)
        const content = files.get(key)
        if (content === undefined) throw new Error(`missing ${key}`)
        return { content, key, path: key }
      },
    })
    const content = defineContent({ sources: { docs } })

    await expect(content.list("docs")).resolves.toHaveLength(50)
    reads.length = 0
    listings = 0
    files.set("page-1.md", "# Edited\n")
    expect((await content.get("/page-1"))?.nodes).toEqual(expect.arrayContaining([expect.arrayContaining(["h1"])]))
    expect(JSON.stringify((await content.get("/page-1"))?.nodes)).toContain("Edited")
    await content.get("/page-2")
    expect(reads).toEqual(["page-1.md", "page-2.md"])
    expect(listings).toBe(0)

    files.set("page-new.md", "# New\n")
    files.delete("page-3.md")
    await content.cache.refresh("docs")
    const paths = (await content.list("docs")).map(document => document.path)
    expect(paths).toContain("/page-new")
    expect(paths).not.toContain("/page-3")
    await expect(content.get("/page-new")).resolves.toEqual(expect.objectContaining({ path: "/page-new" }))
    await content.dispose()
  })

  it("keeps separate Content instances on their own adapted Source loads", async () => {
    let revision = 0
    const source = contentSource(() => ({
      async items() {
        return [{ content: `---\ntitle: Revision ${++revision}\n---\n# Content`, key: "index.md" }]
      },
    }), { prefix: "/docs" })
    const first = defineContent({ source })
    const second = defineContent({ source })

    await first.init()
    await second.init()
    await expect(first.list()).resolves.toEqual([expect.objectContaining({ data: { title: "Revision 1" } })])
    await expect(second.list()).resolves.toEqual([expect.objectContaining({ data: { title: "Revision 2" } })])

    await first.cache.refresh("default")
    await expect(first.list()).resolves.toEqual([expect.objectContaining({ data: { title: "Revision 3" } })])
    await expect(second.list()).resolves.toEqual([expect.objectContaining({ data: { title: "Revision 2" } })])
    expect(revision).toBe(3)
    await Promise.all([first.dispose(), second.dispose()])
  })

  it("keeps each adapted source on one revision while async init parsers read", async () => {
    const revisions = { first: 0, second: 0 }
    const parsed: string[] = []
    registerSources({
      first: {
        name: "first",
        async resolveRevision() {
          return { id: `first-${++revisions.first}`, immutable: true }
        },
        async getKeys() {
          return ["one.slow", "two.slow"]
        },
        async getItem(key, ctx) {
          return { content: `${ctx.revision?.id}:${key}`, key }
        },
      },
      second: {
        name: "second",
        async resolveRevision() {
          return { id: `second-${++revisions.second}`, immutable: true }
        },
        async getKeys() {
          return ["one.slow", "two.slow"]
        },
        async getItem(key, ctx) {
          return { content: `${ctx.revision?.id}:${key}`, key }
        },
      },
    })

    const content = defineContent({
      plugins: [testPlugin("async-init", (content) => {
        content.addParser([".slow"], async ({ partial, read }) => {
          await delay(10)
          const text = await read()
          parsed.push(text)
          return { data: { text }, kind: "document", partial }
        })
      })],
      sources: { first: "first" as SourceName, second: "second" as SourceName },
    })

    await content.init()

    expect(revisions).toEqual({ first: 1, second: 1 })
    expect(parsed.sort()).toEqual([
      "first-1:one.slow",
      "first-1:two.slow",
      "second-1:one.slow",
      "second-1:two.slow",
    ])
  })

  it("keeps overlapping refreshes on separate reader revisions", async () => {
    let revision = 0
    registerSources({
      overlap: {
        name: "overlap",
        async resolveRevision() {
          return { id: String(++revision), immutable: true }
        },
        async getKeys() {
          return ["one.slow", "two.slow"]
        },
        async getItem(key, ctx) {
          return { content: `revision ${ctx.revision?.id}`, key }
        },
      },
    })
    let readBarrier: ReturnType<typeof deferred> | undefined
    let blockedParsers = 0
    let expectedBlockedParsers = 2
    let parsersStarted = deferred()
    const content = defineContent({
      plugins: [testPlugin("overlap", (content) => {
        content.addParser([".slow"], async ({ partial, read }) => {
          const firstText = await read()
          if (readBarrier) {
            blockedParsers++
            if (blockedParsers === expectedBlockedParsers) parsersStarted.resolve()
            await readBarrier.promise
          }
          const texts = [firstText, await read()]
          return { data: { text: texts[0], texts }, kind: "document", partial }
        })
      })],
      sources: { overlap: "overlap" as SourceName },
    })
    await content.init()

    readBarrier = deferred()
    const firstRefresh = content.cache.refresh("overlap")
    await parsersStarted.promise
    expectedBlockedParsers = 4
    parsersStarted = deferred()
    const secondRefresh = content.cache.refresh("overlap")
    await parsersStarted.promise

    expect(revision).toBe(3)
    readBarrier.resolve()
    readBarrier = undefined

    const [firstFiles, secondFiles] = await Promise.all([firstRefresh, secondRefresh])
    expect(firstFiles.map(file => file.data.text)).toEqual(["revision 2", "revision 2"])
    expect(secondFiles.map(file => file.data.text)).toEqual(["revision 3", "revision 3"])
    expect(revision).toBe(3)

    blockedParsers = 0
    expectedBlockedParsers = 2
    parsersStarted = deferred()
    readBarrier = deferred()
    const thirdRefresh = content.cache.refresh("overlap")
    await parsersStarted.promise
    expectedBlockedParsers = 4
    parsersStarted = deferred()
    const snapshot = content.cache.snapshot("overlap", { compress: false })
    await parsersStarted.promise

    expect(revision).toBe(5)
    readBarrier.resolve()
    readBarrier = undefined

    const [, artifact] = await Promise.all([thirdRefresh, snapshot])
    expect(artifact?.data).toContain('"text":"revision 5"')
    expect(revision).toBe(5)

    blockedParsers = 0
    expectedBlockedParsers = 2
    parsersStarted = deferred()
    readBarrier = deferred()
    const fourthRefresh = content.cache.refresh("overlap")
    await parsersStarted.promise
    expectedBlockedParsers = 3
    parsersStarted = deferred()
    const freshGet = content.get("/one", { fresh: true })
    await parsersStarted.promise

    expect(revision).toBe(7)
    readBarrier.resolve()
    readBarrier = undefined

    const [, freshFile] = await Promise.all([fourthRefresh, freshGet])
    expect(freshFile?.data.texts).toEqual(["revision 7", "revision 7"])
    expect(revision).toBe(7)
  })

  it("retains a failed load until its other parsers settle", async () => {
    let revision = 0
    let failLoad = false
    registerSources({
      errors: {
        name: "errors",
        async resolveRevision() {
          return { id: String(++revision), immutable: true }
        },
        async getKeys() {
          return ["fail.test", "late.test"]
        },
        async getItem(key, ctx) {
          return { content: `revision ${ctx.revision?.id}`, key }
        },
      },
    })
    const lateParserStarted = deferred()
    const releaseLateParser = deferred()
    const lateParserFinished = deferred()
    const parsed: string[] = []
    const content = defineContent({
      logger: false,
      onError: "throw",
      plugins: [testPlugin("load-error", (content) => {
        content.addParser([".test"], async ({ filepath, onError, partial, read }) => {
          if (filepath === "fail.test" && failLoad) {
            if (onError === "throw") throw new Error("expected parse failure")
            return null
          }
          if (filepath === "late.test" && failLoad) {
            lateParserStarted.resolve()
            await releaseLateParser.promise
          }
          const text = await read()
          parsed.push(text)
          if (filepath === "late.test" && failLoad) lateParserFinished.resolve()
          return { data: { text }, kind: "document", partial }
        })
      })],
      sources: { errors: "errors" as SourceName },
    })
    await content.init()

    failLoad = true
    let failedRefreshSettled = false
    const failedRefresh = content.cache.refresh("errors").finally(() => {
      failedRefreshSettled = true
    })
    await lateParserStarted.promise
    await expect(failedRefresh).rejects.toThrow("expected parse failure")
    expect(failedRefreshSettled).toBe(true)
    expect(revision).toBe(2)

    failLoad = false
    const nextRefresh = content.cache.refresh("errors")
    await expect(nextRefresh).resolves.toEqual([
      expect.objectContaining({ data: { text: "revision 3" } }),
      expect.objectContaining({ data: { text: "revision 3" } }),
    ])
    failLoad = true
    releaseLateParser.resolve()
    await lateParserFinished.promise
    expect(parsed).toContain("revision 2")
    expect(revision).toBe(3)
  })

  it("accepts an items-only reader and preserves its selected revision", async () => {
    let revision = 1
    const definition = defineSource({
      name: "explicit",
      async resolveRevision() {
        return { id: String(revision), immutable: true }
      },
      async getKeys() {
        return ["index.md"]
      },
      async getItem(key, ctx) {
        return { content: `revision ${ctx.revision?.id}`, key }
      },
    })
    const reader = createSource(definition)
    const source = contentSource({ items: () => reader.items() })
    await source.keys()
    await expect(source.getItem("index.md")).resolves.toBe("revision 1")

    revision = 2
    await source.keys()
    await expect(source.getItem("index.md")).resolves.toBe("revision 1")
  })

  it("accepts direct structured definitions in the single-source form", async () => {
    const settings = defineSource({
      name: "settings",
      async getKeys() {
        return ["settings.json"]
      },
      async getItem(key) {
        return { key, data: { theme: "dark" as const } }
      },
    })
    const reader = createSource(settings)
    expectTypeOf(await reader.get("settings.json")).toMatchTypeOf<{ data: { theme: "dark" } }>()
    const content = defineContent({ plugins: [json()], source: settings })
    await expect(content.get("/settings")).resolves.toEqual(expect.objectContaining({ data: { theme: "dark" } }))
  })

  it("serves media from the latest refreshed reader", async () => {
    let revision = 1
    registerSources({
      media: {
        name: "media",
        async getKeys() {
          return ["logo.png"]
        },
        async getItem() {
          return { content: Uint8Array.of(revision), key: "logo.png" }
        },
      },
    })

    const content = defineContent({
      plugins: [media()],
      sources: { media: "media" as any },
    })
    await content.init()

    revision = 2
    await content.cache.refresh("media")
    revision = 3
    await content.cache.refresh("media")

    await expect(content.media.get("/logo.png")).resolves.toEqual(Uint8Array.of(3))
  })

  it("serializes structured Source data for Comark parsers", async () => {
    registerSources({
      records: {
        name: "records",
        async getKeys() {
          return ["settings.json"]
        },
        async getItem() {
          return { data: { theme: "dark" }, key: "settings.json" }
        },
      },
    })

    const source = contentSource(useSource("records" as any))
    await expect(source.keys()).resolves.toEqual(["settings.json"])
    await expect(source.getItem("settings.json")).resolves.toBe('{"theme":"dark"}')
    await expect(source.getItemRaw("settings.json")).resolves.toEqual({ theme: "dark" })
  })

  it("decodes binary content from another realm", async () => {
    const binary = runInNewContext("new Uint8Array([72, 105])")
    const source = contentSource({
      async items() {
        return [{ content: binary, key: "hello.txt" }]
      },
    } as never)

    await expect(source.getItem("hello.txt")).resolves.toBe("Hi")
  })

  it("does not decode a tagged non-Uint8Array view", async () => {
    const view = new DataView(Uint8Array.of(72, 105).buffer)
    Object.defineProperty(view, Symbol.toStringTag, { value: "Uint8Array" })
    const source = contentSource({
      async items() {
        return [{ content: view, key: "hello.txt" }]
      },
    } as never)

    await expect(source.getItem("hello.txt")).resolves.toBe(view)
  })

  it("refreshes a direct adapter passed to raw Comark Content", async () => {
    let revision = 0
    const parsed: string[] = []
    registerSources({
      direct: {
        name: "direct",
        async resolveRevision() {
          return { id: String(++revision), immutable: true }
        },
        async getKeys() {
          return ["index.md"]
        },
        async getItem(key, ctx) {
          return { content: `revision ${ctx.revision?.id}`, key }
        },
      },
    })
    const content = comarkContent("direct", {
      plugins: [testPlugin("direct-refresh", (content) => {
        content.addParser([".md"], async ({ partial, read }) => {
          const texts = await Promise.all([read(), read()])
          parsed.push(...texts)
          return { data: { text: texts[0] }, kind: "document", partial }
        })
      })],
      source: contentSource("direct" as SourceName),
    })

    await content.init()
    await content.refresh()
    await content.refresh()

    expect(revision).toBe(3)
    expect(parsed).toEqual([
      "revision 1",
      "revision 1",
      "revision 2",
      "revision 2",
      "revision 3",
      "revision 3",
    ])
  })

  it("keeps the last completed raw enumeration after a direct adapter fails", async () => {
    let fail = false
    registerSources({
      raw: {
        name: "raw",
        async getKeys() {
          if (fail) throw new Error("expected enumeration failure")
          return ["logo.png"]
        },
        async getItem(key) {
          return { content: Uint8Array.of(1), key }
        },
      },
    })
    const source = contentSource("raw" as SourceName)

    await expect(source.keys()).resolves.toEqual(["logo.png"])
    await expect(source.getItemRaw("logo.png")).resolves.toEqual(Uint8Array.of(1))
    fail = true
    await expect(source.keys()).rejects.toThrow("expected enumeration failure")
    await expect(source.getItemRaw("logo.png")).resolves.toEqual(Uint8Array.of(1))
  })

  it.each(["registered", "native"] as const)("preserves adapted source options across fresh load adapters (%s)", async (kind) => {
    registerSources({
      options: {
        name: "options",
        async getKeys() { return ["start.md"] },
        async getItem(key) { return { key, content: "# Start" } },
      },
    })
    const schema = { properties: { title: { type: "string" } }, type: "object" } as const
    const input = kind === "registered" ? "options" as SourceName : {
      keys: () => ["start.md"],
      getItem: () => "# Start",
      getItemRaw: () => "# Start",
    }
    const adapted = contentSource(input, { prefix: "/base", schema, url: "/:id" })
    const source = contentSource(adapted, { prefix: "/docs" })
    const content = defineContent({
      sources: {
        docs: source,
        overridden: contentSource(adapted, { prefix: "/other", url: ({ id }) => `/custom/${id}` }),
      },
      seo: { sitemap: true },
      route: false,
      logger: false,
    })

    try {
      expect(content.getSource("docs")).toMatchObject({ prefix: "/docs", schema })
      expect(await content.sitemap()).toEqual([
        { collection: "docs", id: "docs/start", loc: "/docs/start" },
        { collection: "overridden", id: "other/start", loc: "/custom/other/start" },
      ])
    } finally {
      await content.dispose()
    }
  })

  it("rejects source and sources together", () => {
    expect(() => defineContent({
      source: "source" as SourceName,
      sources: { docs: "sources" as SourceName },
    })).toThrow()
  })

  it("rejects Comark parse plugins in plugins", () => {
    const knap = { name: "knap", pre() {} }
    expect(() => defineContent({ plugins: [knap], source: "source" as SourceName })).toThrow(expect.objectContaining({
      code: "CONTENT_R0006",
      message: expect.stringContaining("defineContent({ markdown: { plugins } })"),
    }))

    const mixed = { name: "mixed", setup() {}, post() {} }
    expect(() => defineContent({ plugins: [mixed], source: "source" as SourceName })).toThrow(expect.objectContaining({
      code: "CONTENT_R0006",
      message: expect.stringContaining("defineContent({ markdown: { plugins } })"),
    }))
  })

  it("runs Comark parse plugins from markdown.plugins", async () => {
    const content = defineContent({
      markdown: {
        plugins: [{
          name: "checked",
          post(state) {
            state.tree.meta.checked = true
          },
        }],
      },
      source: { keys: () => ["index.md"], getItem: () => "# Docs", getItemRaw: () => "# Docs" },
    })

    await expect(content.get("/")).resolves.toMatchObject({ meta: { checked: true } })
    await content.dispose()
  })

  it("preserves native Comark Content Sources", async () => {
    const source = {
      async keys() {
        return ["index.md"]
      },
      async getItem() {
        return "# Native"
      },
      async getItemRaw() {
        return "# Native"
      },
    }

    const content = defineContent({ source })
    expect(content.getSource("default")).toBe(source)
    await expect(content.get("/")).resolves.toEqual(expect.objectContaining({ path: "/" }))
  })

  it("preserves a native Source named __proto__", () => {
    const source = {
      async keys() {
        return ["index.md"]
      },
      async getItem() {
        return "# Native"
      },
      async getItemRaw() {
        return "# Native"
      },
    }
    const content = defineContent({ sources: Object.fromEntries([["__proto__", source]]) })

    expect(content.getSource("__proto__")).toBe(source)
  })

  it("preserves prototype-backed native Sources when applying options", async () => {
    class PrototypeSource {
      #content = "# Native"
      prefix = "original"

      async keys() {
        return ["index.md"]
      }

      async getItem() {
        return this.#content
      }

      async getItemRaw() {
        return this.#content
      }
    }

    const source = contentSource(new PrototypeSource(), { prefix: "configured" })

    expect(source.prefix).toBe("configured")
    await expect(source.keys()).resolves.toEqual(["index.md"])
    await expect(source.getItem("index.md")).resolves.toBe("# Native")
  })

  it("preserves native Sources with null-parent constructor prototypes", async () => {
    class NullProtoSource extends null {
      constructor() {
        return Object.create(new.target.prototype)
      }

      async keys() {
        return ["index.md"]
      }

      async getItem() {
        return "# Native"
      }

      async getItemRaw() {
        return "# Native"
      }
    }

    const source = contentSource(new NullProtoSource(), { prefix: "configured" })
    expect(source.prefix).toBe("configured")
    await expect(source.keys()).resolves.toEqual(["index.md"])
    await expect(source.getItem("index.md")).resolves.toBe("# Native")
  })

  it("preserves ViteHub Sources inherited from null-parent constructor prototypes", async () => {
    class NullProtoSource extends null {
      constructor() {
        return Object.create(new.target.prototype)
      }

      async getKeys() {
        return ["index.md"]
      }

      async getItem() {
        return { content: "# Native", key: "index.md" }
      }
    }

    class DerivedSource extends NullProtoSource {}

    const source = contentSource(new DerivedSource() as never)
    await expect(source.keys()).resolves.toEqual(["index.md"])
    await expect(source.getItem("index.md")).resolves.toBe("# Native")
  })

  it("reads inherited class accessors with the source instance as this", async () => {
    class AccessorSource {
      #content = "# Native"

      get keys() {
        return async () => ["index.md"]
      }

      get getItem() {
        const content = this.#content
        return async () => content
      }

      get getItemRaw() {
        const content = this.#content
        return async () => content
      }
    }

    const source = contentSource(new AccessorSource() as never)
    await expect(source.keys()).resolves.toEqual(["index.md"])
    await expect(source.getItem("index.md")).resolves.toBe("# Native")
  })

  it("decodes content bytes created in another realm", async () => {
    const foreignBytes = runInNewContext("new Uint8Array([35, 32, 70, 111, 114, 101, 105, 103, 110])")
    const source = contentSource({
      items: async () => [{ key: "index.md", content: foreignBytes }],
    } as never)

    await expect(source.getItem("index.md")).resolves.toBe("# Foreign")
  })

  it("does not treat a reader with inherited Comark methods as a native source", async () => {
    const source = Object.assign(Object.create({
      keys: async () => ["inherited.md"],
      getItem: async () => "# Inherited",
      getItemRaw: async () => "# Inherited",
    }), {
      items: async () => [{ content: "# Reader", key: "reader.md" }],
    })

    const adapted = contentSource(source as never)
    await expect(adapted.keys()).resolves.toEqual(["reader.md"])
    await expect(adapted.getItem("reader.md")).resolves.toBe("# Reader")
  })

  it("does not treat a reader with inherited Source methods as a Source definition", async () => {
    const source = Object.assign(Object.create({
      getKeys: async () => ["inherited.md"],
      getItem: async () => ({ content: "# Inherited", key: "inherited.md" }),
    }), {
      items: async () => [{ content: "# Reader", key: "reader.md" }],
    })

    const adapted = contentSource(source as never)
    await expect(adapted.keys()).resolves.toEqual(["reader.md"])
    await expect(adapted.getItem("reader.md")).resolves.toBe("# Reader")
  })

  it("does not treat a reader from another realm's Object.prototype as a native source", async () => {
    const source = runInNewContext(`
      Object.prototype.keys = async () => ["inherited.md"];
      Object.prototype.getItem = async () => "# Inherited";
      Object.prototype.getItemRaw = async () => "# Inherited";
      ({ items: async () => [{ content: "# Reader", key: "reader.md" }] })
    `)

    const adapted = contentSource(source as never)
    await expect(adapted.keys()).resolves.toEqual(["reader.md"])
    await expect(adapted.getItem("reader.md")).resolves.toBe("# Reader")
  })

  it("rejects duplicate public paths", async () => {
    registerSources({
      duplicate: {
        name: "duplicate",
        async getKeys() {
          return ["one", "two"]
        },
        async getItem(key: "one" | "two") {
          return { content: key, key, path: "same.md" }
        },
      },
    })

    await expect(contentSource(useSource("duplicate" as any)).keys()).rejects.toThrow("duplicate content path")
  })

  it("rejects unsafe public paths", async () => {
    registerSources({
      unsafe: {
        name: "unsafe",
        async getKeys() {
          return ["secret"]
        },
        async getItem() {
          return { content: "secret", key: "secret", path: "../secret.md" }
        },
      },
    })

    await expect(contentSource(useSource("unsafe" as any)).keys()).rejects.toThrow("Content Source path escapes the source root")
  })

  it("reports malformed source paths with the content diagnostic", async () => {
    const malformed = contentSource({
      items: async () => [{ key: 42, content: "# Invalid" }],
    } as never)

    await expect(malformed.keys()).rejects.toMatchObject({ code: "CONTENT_R0001" })
  })

  it("reports an explicitly malformed path even when the key is valid", async () => {
    const malformed = contentSource({
      items: async () => [{ key: "valid.md", path: 0, content: "# Invalid" }],
    } as never)

    await expect(malformed.keys()).rejects.toMatchObject({ code: "CONTENT_R0001" })
  })

  it("honors an inherited source path", async () => {
    const prototype = { path: "declared.md" }
    const item = Object.assign(Object.create(prototype), { key: "fallback.md", content: "# Declared" })
    const source = contentSource({ items: async () => [item] } as never)

    await expect(source.keys()).resolves.toEqual(["declared.md"])
  })

  it("falls back to the key when the optional path is undefined", async () => {
    const source = contentSource({
      items: async () => [{ key: "fallback.md", path: undefined, content: "# Fallback" }],
    } as never)

    await expect(source.keys()).resolves.toEqual(["fallback.md"])
  })
})

describe("renderContentHtml", () => {
  it("renders a document with the Comark UI components that Content parses, and app components", async () => {
    const content = defineContent({ route: false, source: { async items() { return [{ key: "guide", path: "guide.md", content: "# Guide\n\nArea $x^2$.\n\n::alert{type=\"info\"}\nNote\n::\n" }] } } })
    const guide = (await content.get("/guide"))!
    const html = await renderContentHtml(guide)
    expect(html).toContain("<h1 id=\"guide\">Guide</h1>")
    expect(html).toMatch(/<math>.*<mi>x<\/mi>/)
    expect(html).not.toMatch(/<(formula|typeset-styles)[\s>]/)
    expect(await renderContentHtml(guide, { components: { alert: () => "<aside>custom</aside>" } })).toContain("<aside>custom</aside>")
  })
})

describe("defineContentHandler", () => {
  it("disables HTTP access while retaining server reads", async () => {
    const content = defineContent({ route: false, source: { async items() { return [{ key: "guide", path: "guide.md", content: "# Guide" }] } } })
    expect(await content.get("/guide")).toMatchObject({ path: "/guide" })
    const response = await defineContentHandler(content).fetch(new Request("https://example.test/api/content/guide"))
    expect(response.status).toBe(404)
    expect(await content.get("/guide")).toMatchObject({ path: "/guide" })
  })

  const guide = { async items() { return [{ key: "guide", path: "guide.md", content: "# Guide" }] } }
  const request = () => new Request("https://example.test/api/content/get/guide")

  it("asks authorize for read before it serves a request", async () => {
    const policy = vi.fn<ContentAuthorize>(({ user, action }) => action === "read" && user?.id === "ana")
    const content = defineContent({ source: guide, authorize: policy })
    expect((await defineContentHandler(content).fetch(request())).status).toBe(401)
    expect((await defineContentHandler(content, { user: () => ({ id: "ben" }) }).fetch(request())).status).toBe(403)
    const allowed = await defineContentHandler(content, { user: () => ({ id: "ana" }) }).fetch(request())
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ path: "/guide" })
    expect(policy).toHaveBeenLastCalledWith({ user: { id: "ana" }, action: "read" })
  })

  it("serves everyone without authorize when route is public", async () => {
    const policy = vi.fn<ContentAuthorize>(() => false)
    const content = defineContent({ source: guide, authorize: policy, route: "public" })
    expect((await defineContentHandler(content).fetch(request())).status).toBe(200)
    expect(policy).not.toHaveBeenCalled()
  })

  it("requires a decision before it serves a github() Source", () => {
    const handbook = github({ repo: "acme/private" })
    expect(() => defineContent({ sources: { handbook } })).toThrow(/route: "public"/)
    expect(() => defineContent({ sources: { handbook }, route: true })).toThrow(/authorize/)
    expect(defineContent({ sources: { handbook }, route: "public" }).route).toBe("public")
    expect(defineContent({ sources: { handbook }, route: false }).route).toBe(false)
    expect(defineContent({ sources: { handbook }, authorize: ({ user }) => user !== null }).route).toBe(true)
  })

  it("rejects an unknown route value", () => {
    expect(() => defineContent({ source: guide, route: "open" as never })).toThrow(/must be true, false, or "public"/)
  })

  it("asks read for the whole route, and read-draft for one collection", async () => {
    const policy = vi.fn<ContentAuthorize>(() => true)
    const content = defineContent({ source: guide, authorize: policy })
    expect(await content.can({ action: "read" })).toBe(true)
    expect(policy).toHaveBeenLastCalledWith({ user: null, action: "read" })
    await expect(content.can({ action: "read", collection: "posts" } as never)).rejects.toMatchObject({ code: "CONTENT_R0008" })
    expect(await defineContent({ source: guide }).can({ action: "read" })).toBe(false)
  })
})
