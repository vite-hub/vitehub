import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

import sqliteFullTextSearch from "comark-content/plugins/sqlite-full-text-search"
import { afterEach, expect, it, vi } from "vitest"

import { clearSources, defineSource } from "@vite-hub/source"

import { defineContent } from "../src/index.ts"
import { sqlite as nodeSqlite } from "../src/sqlite.ts"

// Nitro compiles the `.wasm` file at build time. Node can compile it here, so the Workers adapter runs in this test.
vi.mock("@sqlite.org/sqlite-wasm/sqlite3.wasm?module", async () => {
  const require = createRequire(import.meta.url)
  const wasm: { Module: new (bytes: Uint8Array) => object } = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly")?.value
  return { default: new wasm.Module(await readFile(require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"))) }
})

afterEach(clearSources)

const pages: Record<string, string> = {
  "guide/index.md": "---\ntitle: Introduction\n---\n# Start\n\nRuntime content for every host.\n\n## Deploy\n\nDeploy the Worker to Cloudflare.\n",
  "guide/search.md": "---\ntitle: Search\n---\n# Search\n\nFull-text search ranks pages with bm25.\n\n## Workers\n\nSearch runs on Cloudflare Workers too.\n",
}

function docs() {
  return defineSource({
    name: "docs",
    async getKeys() {
      return Object.keys(pages)
    },
    async getItem(key: string) {
      return { content: pages[key], key, path: key }
    },
  })
}

it.each([
  ["Node SQLite", async () => nodeSqlite],
  ["SQLite WASM for Workers", async () => (await import("../src/sqlite-workerd.ts")).sqlite],
])("indexes Sources for full-text search with %s", async (_name, load) => {
  const sqlite = await load()
  const content = defineContent({
    plugins: [sqliteFullTextSearch({ database: sqlite() })],
    sources: { docs: docs() },
  })
  const ids = async (query: string) => (await content.search(["docs"], query)).map(result => result.id)
  await expect(ids("Cloudflare")).resolves.toEqual(["/guide#deploy", "/guide/search#workers"])
  await expect(ids("bm25")).resolves.toEqual(["/guide/search#search"])
  await expect(content.search(["docs"], "Worker", { snippet: { columns: ["content"] } })).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ snippets: { content: expect.stringContaining("<mark>") } })]),
  )
})
