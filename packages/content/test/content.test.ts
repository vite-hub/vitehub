import { comarkContent, type ContentPlugin } from "comark-content"
import sqlite from "comark-content/database/sqlite-node"
import media from "comark-content/plugins/media"
import sqliteFullTextSearch from "comark-content/plugins/sqlite-full-text-search"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"

import { clearSources, registerSources, useSource } from "@vite-hub/source"

import { contentSource, defineContent } from "../src/index.ts"

afterEach(clearSources)

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
    registerSources({
      docs: {
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
      },
    })

    const content = defineContent({
      plugins: [sqliteFullTextSearch({ database: sqlite() })],
      sources: { docs: "docs" },
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

  it("uses a fresh Source Reader when Comark refreshes runtime content", async () => {
    let revision = 1
    registerSources({
      live: {
        name: "live",
        async resolveRevision() {
          return { id: String(revision), immutable: true }
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
      },
    })

    const content = defineContent({ source: "live" as any })
    await expect(content.get("/", { fresh: true })).resolves.toEqual(
      expect.objectContaining({ nodes: expect.arrayContaining([expect.any(Array)]) }),
    )

    revision = 2
    await content.cache.refresh("default")

    const refreshed = await content.get("/")
    expect(JSON.stringify(refreshed?.nodes)).toContain("Revision 2")
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
      sources: { first: "first", second: "second" },
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
      sources: { overlap: "overlap" },
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
      sources: { errors: "errors" },
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
    const content = comarkContent({
      plugins: [testPlugin("direct-refresh", (content) => {
        content.addParser([".md"], async ({ partial, read }) => {
          const texts = await Promise.all([read(), read()])
          parsed.push(...texts)
          return { data: { text: texts[0] }, kind: "document", partial }
        })
      })],
      sources: { direct: contentSource("direct") },
    })

    await content.init()
    await content.cache.refresh("direct")
    await content.cache.refresh("direct")

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
    const source = contentSource("raw")

    await expect(source.keys()).resolves.toEqual(["logo.png"])
    await expect(source.getItemRaw("logo.png")).resolves.toEqual(Uint8Array.of(1))
    fail = true
    await expect(source.keys()).rejects.toThrow("expected enumeration failure")
    await expect(source.getItemRaw("logo.png")).resolves.toEqual(Uint8Array.of(1))
  })

  it("preserves adapted source options across fresh load adapters", () => {
    const schema = { properties: { title: { type: "string" } }, type: "object" } as const
    const source = contentSource(contentSource("options", { prefix: "/base", schema }), { prefix: "/docs" })
    const content = defineContent({ sources: { docs: source } })

    expect(content.getSource("docs")).toMatchObject({ prefix: "/docs", schema })
  })

  it("rejects source and sources together", () => {
    expect(() => defineContent({
      source: "source",
      sources: { docs: "sources" },
    })).toThrow()
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
})
