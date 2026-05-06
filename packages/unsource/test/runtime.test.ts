import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

import { createMemoryStorage, setStorage } from "ocache"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  clearSources,
  custom,
  defineSources,
  file,
  github,
  glob,
  markdown,
  registerSources,
  SourceNotFoundError,
  useSource,
} from "../src/index.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-unsource-root-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  clearSources()
  setStorage(createMemoryStorage())
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  })
}

interface StubGitHubSourceOptions {
  apiStatus?: number
  archiveStatus?: number
}

function createTarGz(files: Record<string, string>) {
  const blocks: Buffer[] = []
  for (const [path, value] of Object.entries(files)) {
    const content = Buffer.from(value)
    const header = Buffer.alloc(512)
    header.write(`archive-main/${path}`, 0, 100)
    header.write("0000644\0", 100, 8)
    header.write("0000000\0", 108, 8)
    header.write("0000000\0", 116, 8)
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12)
    header.write("00000000000\0", 136, 12)
    header.fill(" ", 148, 156)
    header.write("0", 156, 1)
    header.write("ustar\0", 257, 6)
    header.write("00", 263, 2)
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8)
    blocks.push(header, content)
    const padding = (512 - (content.length % 512)) % 512
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function stubGitHubSource(files: Record<string, string>, options: StubGitHubSourceOptions | number = 200) {
  const apiStatus = typeof options === "number" ? options : options.apiStatus ?? 200
  const archiveStatus = typeof options === "number" ? options : options.archiveStatus ?? 200

  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const requestUrl = String(url)

    if (requestUrl.startsWith("https://codeload.github.com/")) {
      if (archiveStatus !== 200) return new Response("not found", { status: archiveStatus })
      return new Response(createTarGz(files))
    }

    if (apiStatus !== 200) {
      return jsonResponse({ message: "not found" }, apiStatus)
    }

    if (requestUrl.includes("/git/trees/")) {
      return jsonResponse({
        sha: "tree-sha",
        tree: [
          ...Object.keys(files).map(path => ({ path, sha: `sha-${path}`, type: "blob" })),
          { path: "docs/guide", type: "tree" },
        ],
      })
    }

    if (requestUrl.startsWith("https://raw.githubusercontent.com/")) {
      const url = new URL(requestUrl)
      const path = decodeURIComponent(url.pathname.split("/").slice(4).join("/"))
      const content = files[path]
      if (content === undefined) return new Response("not found", { status: 404 })
      return new Response(content)
    }

    const path = decodeURIComponent(requestUrl.match(/contents\/(?<path>.+)\?ref/)?.groups?.path ?? "")
    return jsonResponse({
      content: Buffer.from(files[path] || "").toString("base64"),
      encoding: "base64",
    })
  }))
}

describe("@vitehub/unsource providers", () => {
  it("registers sources and reads through useSource", async () => {
    registerSources(defineSources({
      docs: file({ content: "# Docs\n", workspacePath: "README.md" }),
      custom: custom({
        name: "custom",
        async getKeys() {
          return ["data.json"]
        },
        async getItem(key) {
          return { key, data: { ok: true } }
        },
      }),
    }))

    const docs = useSource("docs")

    await expect(docs.keys()).resolves.toEqual(["README.md"])
    await expect(docs.read("README.md")).resolves.toBe("# Docs\n")
    await expect(docs.get("README.md")).resolves.toMatchObject({ mediaType: "text/markdown" })
    await expect(docs.exists("README.md")).resolves.toBe(true)
    await expect(docs.exists("missing.md" as any)).resolves.toBe(false)
    await expect(docs.list()).resolves.toEqual([{ key: "README.md", type: "file" }])
    await expect(useSource("custom").get("data.json")).resolves.toMatchObject({ data: { ok: true } })
  })

  it("throws a source-specific error for missing registrations", () => {
    expect(() => useSource("missing" as any)).toThrow(SourceNotFoundError)
  })

  it("loads file, markdown, and glob providers", async () => {
    const root = await createRoot()
    await mkdir(join(root, "docs"), { recursive: true })
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(root, "docs", "README.md"), "# Docs\n")
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n")
    await writeFile(join(root, "node_modules", "pkg", "skip.md"), "# Skip\n")

    registerSources(defineSources({
      docs: glob({ cwd: ".", include: "**/*.md" }),
      readme: markdown({ path: "docs/README.md", workspacePath: "README.md" }),
    }))

    await expect(useSource("docs", { rootDir: root }).keys()).resolves.toEqual([
      "docs/guide.md",
      "docs/README.md",
    ])
    await expect(useSource("readme", { rootDir: root }).get("README.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
    })
  })

  it("lists GitHub files under the configured root with relative keys", async () => {
    stubGitHubSource({
      "dbt/dbt_project.yml": "name: app\n",
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    })

    registerSources({ dbt: github({ repo: "acme/app", root: "dbt" }) })

    await expect(useSource("dbt").keys()).resolves.toEqual([
      "dbt_project.yml",
      "models/marts/orders.sql",
    ])
  })

  it("applies GitHub include and exclude filters to root-relative keys", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "dbt/models/private/secret.sql": "select secret\n",
      "dbt/models/marts/orders.yml": "version: 2\n",
      "dbt/macros/date_spine.sql": "{% macro date_spine() %}{% endmacro %}\n",
    })

    registerSources({
      dbt: github({
        exclude: "models/private/**",
        include: ["models/**/*.sql", "macros/**/*.sql"],
        repo: "acme/app",
        root: "dbt",
      }),
    })

    await expect(useSource("dbt").keys()).resolves.toEqual([
      "models/marts/orders.sql",
      "macros/date_spine.sql",
    ])
  })

  it("falls back to GitHub archives when the tree API is rate limited", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })

    registerSources({ dbt: github({ repo: "acme/app", root: "dbt" }) })

    const dbt = useSource("dbt")

    await expect(dbt.keys()).resolves.toEqual(["models/marts/orders.sql"])
    await expect(dbt.read("models/marts/orders.sql")).resolves.toBe("select 1\n")
  })

  it("falls back to raw GitHub bytes when the contents API does not return base64", async () => {
    stubGitHubSource({ "metadata.xml": "<metadata />\n" })
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      if (requestUrl.includes("/git/trees/")) {
        return jsonResponse({
          sha: "tree-sha",
          tree: [{ path: "metadata.xml", type: "blob" }],
        })
      }
      if (requestUrl.includes("/contents/")) {
        return jsonResponse({ content: "", encoding: "none" })
      }
      if (requestUrl.startsWith("https://raw.githubusercontent.com/")) {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer token")
        return new Response("<metadata />\n")
      }
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    })

    registerSources({ github: github({ auth: () => "token", repo: "acme/app" }) })

    await expect(useSource("github").read("metadata.xml")).resolves.toBe("<metadata />\n")
  })

  it("dedupes cached GitHub tree and content reads", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    registerSources({
      docs: github({
        cache: { maxAge: 3600, swr: true },
        repo: "acme/app",
        root: "docs",
      }),
    })

    const docs = useSource("docs")

    await expect(Promise.all([
      docs.read("README.md"),
      docs.read("README.md"),
    ])).resolves.toEqual(["# Docs\n", "# Docs\n"])

    const treeCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/git/trees/"))
    const contentCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://raw.githubusercontent.com/"))
    expect(treeCalls).toHaveLength(1)
    expect(contentCalls).toHaveLength(1)
  })
})
