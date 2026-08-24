import { comarkContent } from "comark-content"
import sqlite from "comark-content/database/sqlite-node"
import sqliteFullTextSearch from "comark-content/plugins/sqlite-full-text-search"
import { afterEach, describe, expect, it } from "vitest"

import { contentSource } from "../src/content.ts"
import { clearSources, registerSources, useSource } from "../src/index.ts"

afterEach(clearSources)

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

    const content = comarkContent({
      basePath: "/api/content",
      plugins: [sqliteFullTextSearch({ database: sqlite() })],
      sources: { docs: contentSource("docs") },
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

    const content = comarkContent({ sources: { live: contentSource("live" as any) } })
    await expect(content.get("/", { fresh: true })).resolves.toEqual(
      expect.objectContaining({ nodes: expect.arrayContaining([expect.any(Array)]) }),
    )

    revision = 2
    await content.cache.refresh("live")

    const refreshed = await content.get("/")
    expect(JSON.stringify(refreshed?.nodes)).toContain("Revision 2")
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

    await expect(contentSource(useSource("unsafe" as any)).keys()).rejects.toThrow("Source path escapes the source root")
  })
})
