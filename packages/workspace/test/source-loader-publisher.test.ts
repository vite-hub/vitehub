import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"

import { createMemoryStorage, setStorage } from "ocache"
import { afterEach, describe, expect, it, vi } from "vitest"

import { collectWorkspaceStoreAssetBundle, syncDiscoveredWorkspaceAssetBundles, writeWorkspaceAssetsRegistry } from "../src/build/assets.ts"
import { initializeWorkspaceAssetRegistry, syncWorkspaceBuildAssets } from "../src/build/integration.ts"
import { defineWorkspace, source, useWorkspace } from "../src/index.ts"
import * as loader from "../src/loader.ts"
import * as publish from "../src/publish.ts"
import { registerWorkspace } from "../src/test.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { useRegisteredWorkspace } from "../src/core/registry.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-root-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  delete process.env.GITHUB_TOKEN
  delete (globalThis as { __env__?: Record<string, unknown> }).__env__
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

    if (requestUrl === "https://api.github.com/repos/acme/app" || requestUrl === "https://api.github.com/repos/acme/private" || requestUrl === "https://api.github.com/repos/acme/public") {
      return jsonResponse({ default_branch: "main" })
    }

    if (requestUrl.endsWith("/commits/main")) {
      return jsonResponse({ sha: "latest-commit-sha" })
    }

    if (requestUrl.includes("/git/trees/")) {
      return jsonResponse({
        sha: "tree-sha",
        tree: [
          ...Object.keys(files).map(path => ({ path, type: "blob" })),
          { path: "dbt/models", type: "tree" },
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

function archiveRequestAuthorizations() {
  return vi.mocked(fetch).mock.calls
    .filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization)
}

function archiveRequestAuthorization() {
  const [authorization] = archiveRequestAuthorizations()
  return authorization
}

describe("sources, loaders, and publishers", () => {
  it("keeps Vite out of statically bundled workspace runtime output", async () => {
    const output = await readFile(join(import.meta.dirname, "../dist/index.js"), "utf8")

    expect(output).not.toContain('import("vite")')
    expect(output).not.toContain("createRequire(import.meta.url)")
    expect(output).not.toContain("node-fetch-native")
    expect(output).not.toContain("node:http")
  })

  it("lists GitHub files under the configured root with relative keys", async () => {
    stubGitHubSource({
      "dbt/dbt_project.yml": "name: app\n",
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    })

    const githubSource = source.github({
      repo: "acme/app",
      root: "dbt",
    })

    await expect(githubSource.getKeys({ rootDir: "", workspace: "github" })).resolves.toEqual([
      "dbt_project.yml",
      "models/marts/orders.sql",
    ])
  })

  it("resolves default GitHub refs to a commit snapshot", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    const githubSource = source.github({ repo: "acme/app" })

    await expect(githubSource.getKeys({ rootDir: "", workspace: "github-default-ref" })).resolves.toEqual(["docs/README.md"])
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/commits/main"))).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/tar.gz/latest-commit-sha"))).toBe(true)
  })

  it("applies GitHub include and exclude filters to root-relative keys", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "dbt/models/private/secret.sql": "select secret\n",
      "dbt/models/marts/orders.yml": "version: 2\n",
      "dbt/macros/date_spine.sql": "{% macro date_spine() %}{% endmacro %}\n",
    })

    const githubSource = source.github({
      repo: "acme/app",
      root: "dbt",
      include: ["models/**/*.sql", "macros/**/*.sql"],
      exclude: "models/private/**",
    })

    await expect(githubSource.getKeys({ rootDir: "", workspace: "github-filters" })).resolves.toEqual([
      "models/marts/orders.sql",
      "macros/date_spine.sql",
    ])
  })

  it("resolves GitHub auth lazily from runtime env", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })
    process.env.GITHUB_TOKEN = "first-token"

    const githubSource = source.github({ repo: "acme/private" })

    await expect(githubSource.getKeys({ rootDir: "", workspace: "github-auth" })).resolves.toEqual(["docs/README.md"])
    process.env.GITHUB_TOKEN = "second-token"
    await expect(githubSource.getKeys({ rootDir: "", workspace: "github-auth" })).resolves.toEqual(["docs/README.md"])

    expect(archiveRequestAuthorizations()).toEqual([
      "Bearer first-token",
      "Bearer second-token",
    ])
  })

  it("resolves GitHub auth from local env files without mutating process env", async () => {
    const root = await createRoot()
    await writeFile(join(root, ".env"), "GITHUB_TOKEN=env-file-token\n")
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    const githubSource = source.github({ repo: "acme/private" })

    await expect(githubSource.getKeys({ rootDir: root, workspace: "github-env-file-auth" })).resolves.toEqual(["docs/README.md"])

    expect(archiveRequestAuthorization()).toBe("Bearer env-file-token")
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  it("re-reads GitHub auth from local env files", async () => {
    const root = await createRoot()
    await writeFile(join(root, ".env"), "GITHUB_TOKEN=first-env-file-token\n")
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    const githubSource = source.github({ repo: "acme/private" })

    await expect(githubSource.getKeys({ rootDir: root, workspace: "github-env-file-auth" })).resolves.toEqual(["docs/README.md"])
    await writeFile(join(root, ".env"), "GITHUB_TOKEN=second-env-file-token\n")
    await expect(githubSource.getKeys({ rootDir: root, workspace: "github-env-file-auth" })).resolves.toEqual(["docs/README.md"])

    expect(archiveRequestAuthorizations()).toEqual([
      "Bearer first-env-file-token",
      "Bearer second-env-file-token",
    ])
  })

  it("prefers runtime GitHub auth over local env files", async () => {
    const root = await createRoot()
    await writeFile(join(root, ".env"), "GITHUB_TOKEN=env-file-token\n")
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })
    process.env.GITHUB_TOKEN = "runtime-token"

    const githubSource = source.github({ repo: "acme/private" })

    await githubSource.getKeys({ rootDir: root, workspace: "github-runtime-auth" })

    expect(archiveRequestAuthorization()).toBe("Bearer runtime-token")
  })

  it("prefers Cloudflare GitHub auth over local env files", async () => {
    const root = await createRoot()
    await writeFile(join(root, ".env"), "GITHUB_TOKEN=env-file-token\n")
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })
    ;(globalThis as { __env__?: Record<string, unknown> }).__env__ = { GITHUB_TOKEN: "cloudflare-token" }

    const githubSource = source.github({ repo: "acme/private" })

    await githubSource.getKeys({ rootDir: root, workspace: "github-cloudflare-auth" })

    expect(archiveRequestAuthorization()).toBe("Bearer cloudflare-token")
  })

  it("prefers explicit GitHub auth over Cloudflare runtime env", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })
    ;(globalThis as { __env__?: Record<string, unknown> }).__env__ = { GITHUB_TOKEN: "cloudflare-token" }

    const githubSource = source.github({ auth: "explicit-token", repo: "acme/private" })

    await githubSource.getKeys({ rootDir: "", workspace: "github-auth" })

    expect(archiveRequestAuthorization()).toBe("Bearer explicit-token")
  })

  it("prefers explicit GitHub auth over local env files", async () => {
    const root = await createRoot()
    await writeFile(join(root, ".env"), "GITHUB_TOKEN=env-file-token\n")
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    const githubSource = source.github({ auth: "explicit-token", repo: "acme/private" })

    await githubSource.getKeys({ rootDir: root, workspace: "github-explicit-auth" })

    expect(archiveRequestAuthorization()).toBe("Bearer explicit-token")
  })

  it("keeps public GitHub source requests unauthenticated when no token exists", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    const githubSource = source.github({ repo: "acme/public" })

    await githubSource.getKeys({ rootDir: "", workspace: "github-public" })

    expect(archiveRequestAuthorization()).toBeUndefined()
  })

  it("falls back to GitHub archives when the public tree API is rate limited", async () => {
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })

    const githubSource = source.github({
      repo: "acme/app",
      root: "dbt",
    })

    await expect(githubSource.getKeys({ rootDir: "", workspace: "github-archive" })).resolves.toEqual([
      "models/marts/orders.sql",
    ])
    const item = await githubSource.getItem("models/marts/orders.sql", { rootDir: "", workspace: "github-archive" })
    expect(item.key).toBe("models/marts/orders.sql")
    expect(Buffer.from(item.content as Uint8Array).toString("utf8")).toBe("select 1\n")
  })

  it("falls back to GitHub archives when an env token is rate limited", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    }, { apiStatus: 403 })
    process.env.GITHUB_TOKEN = "stale-token"

    const githubSource = source.github({
      repo: "acme/app",
    })

    await expect(githubSource.getKeys({ rootDir: "", workspace: "github-archive" })).resolves.toEqual([
      "docs/README.md",
    ])
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("https://codeload.github.com/"))).toBe(true)
  })

  it("loads GitHub bytes from archive snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn())
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      if (requestUrl === "https://api.github.com/repos/acme/app") {
        return jsonResponse({ default_branch: "main" })
      }
      if (requestUrl.endsWith("/commits/main")) {
        return jsonResponse({ sha: "latest-commit-sha" })
      }
      if (requestUrl.startsWith("https://codeload.github.com/")) {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer token")
        return new Response(createTarGz({ "metadata.xml": "<metadata />\n" }))
      }
      throw new Error(`Unexpected GitHub request: ${requestUrl}`)
    })

    const githubSource = source.github({
      auth: "token",
      repo: "acme/app",
    })

    const item = await githubSource.getItem("metadata.xml", { rootDir: "", workspace: "github-raw-fallback" })

    expect(Buffer.from(item.content as Uint8Array).toString("utf8")).toBe("<metadata />\n")
  })

  it("reuses cached GitHub archives across lazy source navigation", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
      "docs/guide/setup.md": "# Setup\n",
    })

    registerWorkspace("github-lazy-tree-cache", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.github({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          mount: "docs",
          repo: "acme/app",
          root: "docs",
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("github-lazy-tree-cache")
    await workspace.sync()

    await expect(workspace.list("docs")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/README.md", type: "file" }),
      expect.objectContaining({ path: "docs/guide", type: "directory" }),
    ]))
    await expect(workspace.stat("docs/README.md")).resolves.toMatchObject({ path: "docs/README.md", type: "file" })
    await expect(workspace.exists("docs/guide/setup.md")).resolves.toBe(true)

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls).toHaveLength(1)
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "docs/README.md", type: "added" }),
        expect.objectContaining({ path: "docs/guide/setup.md", type: "added" }),
      ]),
    })
  })

  it("dedupes concurrent cached GitHub archive reads while materializing once", async () => {
    stubGitHubSource({
      "docs/README.md": "# Docs\n",
    })

    registerWorkspace("github-lazy-content-cache", defineWorkspace({
      store: { provider: "memory" },
      sources: {
        docs: source.github({
          cache: { maxAge: 3600 },
          materialize: "lazy",
          mount: "docs",
          repo: "acme/app",
          root: "docs",
        }),
      },
    }))

    const workspace = await useRegisteredWorkspace("github-lazy-content-cache")
    await workspace.sync()

    await expect(Promise.all([
      workspace.readFile("docs/README.md"),
      workspace.readFile("docs/README.md"),
    ])).resolves.toEqual(["# Docs\n", "# Docs\n"])

    const archiveCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://codeload.github.com/"))
    expect(archiveCalls).toHaveLength(1)
    await expect(workspace.diff()).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ path: "docs/README.md", type: "added" })]),
    })
  })

  it("loads GitHub file bytes and writes them through the files loader", async () => {
    const root = await createRoot()
    stubGitHubSource({
      "dbt/models/marts/orders.sql": "select 1\n",
    })

    registerWorkspace("github-loader", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: source.github({
          mount: "docs",
          repo: "acme/app",
          root: "dbt",
        }),
      },
      loaders: [loader.files()],
    }))

    const workspace = useWorkspace("github-loader", { mode: "write" })

    await expect(workspace.fs.readFile("docs/models/marts/orders.sql")).resolves.toBe("select 1\n")
  })

  it("initializes empty workspace assets before explicit source sync", async () => {
    const root = await createRoot()
    const directory = join(root, "server", "workspaces", "docs")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "config.ts"), "export default {}\n")
    await writeFile(join(directory, "AGENTS.md"), "# Instructions\n")
    await writeFile(join(directory, "README.md"), "# Docs\n")
    const registryFile = join(root, ".vitehub", "nitro-runtime", "workspace", "assets", "registry.mjs")

    await initializeWorkspaceAssetRegistry(registryFile, [{
      handler: join(directory, "config.ts"),
      name: "docs",
      path: join(directory, "config.ts"),
      source: "test",
    }], root)

    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default
    expect(registry.docs).toBeUndefined()
  })

  it("syncs explicit directory workspace sources on build", async () => {
    const root = await createRoot()
    const directory = join(root, "server", "workspaces", "docs")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "config.mjs"), [
      "export default {",
      "  sources: {",
      "    instructions: {",
      "      async getKeys() { return ['AGENTS.md'] },",
      "      async getItem(key) { return { key, path: key, content: '# Instructions\\n' } },",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(directory, "AGENTS.md"), "# Instructions\n")
    const registryFile = join(root, ".vitehub", "nitro-runtime", "workspace", "assets", "registry.mjs")

    await syncWorkspaceBuildAssets([{
      handler: join(directory, "config.mjs"),
      name: "docs",
      path: join(directory, "config.mjs"),
      source: "test",
    }], root, {
      root: join(root, ".vitehub", "workspaces"),
      store: { provider: "memory" },
      assets: true,
    }, registryFile)

    const contents = await readFile(registryFile, "utf8")
    expect(contents.match(/"docs": createWorkspaceAssets/g)).toHaveLength(1)
    expect(contents.match(/"instructions\/AGENTS.md"/g)).toHaveLength(1)
  })

  it("preserves empty source root overrides while syncing build assets", async () => {
    const root = await createRoot()
    const directory = join(root, "server", "workspaces", "docs")
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, "README.md"), "# Root\n")
    await writeFile(join(directory, "README.md"), "# Directory\n")
    await writeFile(join(directory, "config.mjs"), [
      "import { source } from '@vitehub/workspace'",
      "export default {",
      "  sourceRootDir: '',",
      "  sources: { docs: source.glob({ include: ['README.md'] }) },",
      "}",
      "",
    ].join("\n"))

    const bundles = await syncDiscoveredWorkspaceAssetBundles([{
      handler: join(directory, "config.mjs"),
      name: "docs",
      path: join(directory, "config.mjs"),
      source: "test",
      sourceRootDir: directory,
    }], root, {
      root: join(root, ".vitehub", "workspaces"),
      store: { provider: "memory" },
      assets: true,
    })

    expect(bundles).toHaveLength(1)
    expect(bundles[0]).toMatchObject({
      files: [expect.objectContaining({ path: "docs/README.md" })],
      name: "docs",
    })
    expect(Buffer.from(bundles[0]!.files[0]!.content)).toEqual(Buffer.from("# Root\n"))
  })

  it("purges stale build source files when source maps change", async () => {
    const store = createMemoryWorkspaceStore()
    let keys = ["README.md", "stale.md"]
    const docsSource = source.custom({
      async getKeys() {
        return keys
      },
      async getItem(key) {
        return { key, path: key, content: `# ${key}\n` }
      },
      mount: "docs",
    })
    const definition: WorkspaceDefinition = {
      name: "stale-build-sources",
      sources: { docs: docsSource },
    }

    await syncWorkspaceDefinition(definition, store)
    await expect(store.readFile("docs/stale.md")).resolves.toMatchObject({ content: "# stale.md\n" })

    keys = ["README.md"]
    await syncWorkspaceDefinition(definition, store)
    await expect(store.readFile("docs/README.md")).resolves.toMatchObject({ content: "# README.md\n" })
    await expect(store.readFile("docs/stale.md")).resolves.toBeUndefined()

    await syncWorkspaceDefinition({
      name: "stale-build-sources",
      sources: {},
    }, store)
    await expect(store.list("", { recursive: true })).resolves.toEqual([])
  })

  it("purges stale root-mounted build source files when source maps change", async () => {
    const store = createMemoryWorkspaceStore()
    let keys = ["AGENTS.md", "stale.md"]
    const rootSource = source.custom({
      async getKeys() {
        return keys
      },
      async getItem(key) {
        return { key, path: key, content: `# ${key}\n` }
      },
      mount: "",
    })
    const definition: WorkspaceDefinition = {
      name: "stale-root-build-sources",
      sources: { rootFiles: rootSource },
    }

    await syncWorkspaceDefinition(definition, store)
    await expect(store.readFile("stale.md")).resolves.toMatchObject({ content: "# stale.md\n" })

    keys = ["AGENTS.md"]
    await syncWorkspaceDefinition(definition, store)

    await expect(store.readFile("AGENTS.md")).resolves.toMatchObject({ content: "# AGENTS.md\n" })
    await expect(store.readFile("stale.md")).resolves.toBeUndefined()
  })

  it("purges stale local build source files after store restarts", async () => {
    const root = await createRoot()
    const storeRoot = join(root, ".vitehub", "workspaces", "docs")
    const docsSource = source.file({ content: "# Docs\n", workspacePath: "README.md", mount: "docs" })
    const definition: WorkspaceDefinition = {
      name: "stale-local-build-sources",
      sources: { docs: docsSource },
    }

    await syncWorkspaceDefinition(definition, createLocalWorkspaceStore(storeRoot))
    await expect(createLocalWorkspaceStore(storeRoot).readFile("docs/README.md")).resolves.toMatchObject({ path: "docs/README.md" })

    await syncWorkspaceDefinition({
      name: "stale-local-build-sources",
      sources: {},
    }, createLocalWorkspaceStore(storeRoot))

    await expect(createLocalWorkspaceStore(storeRoot).readFile("docs/README.md")).resolves.toBeUndefined()
  })

  it("filters synced explicit workspace assets by configured assets", async () => {
    const root = await createRoot()
    const selectedDirectory = join(root, "server", "workspaces", "selected")
    const skippedDirectory = join(root, "server", "workspaces", "skipped")
    await mkdir(selectedDirectory, { recursive: true })
    await mkdir(skippedDirectory, { recursive: true })
    await writeFile(join(selectedDirectory, "config.mjs"), [
      "export default {",
      "  sources: {",
      "    instructions: {",
      "      async getKeys() { return ['AGENTS.md'] },",
      "      async getItem(key) { return { key, path: key, content: '# Selected\\n' } },",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(skippedDirectory, "config.mjs"), [
      "export default {",
      "  sources: {",
      "    instructions: {",
      "      async getKeys() { return ['AGENTS.md'] },",
      "      async getItem(key) { return { key, path: key, content: '# Skipped\\n' } },",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n"))
    const registryFile = join(root, ".vitehub", "nitro-runtime", "workspace", "assets", "registry.mjs")

    await syncWorkspaceBuildAssets([{
      handler: join(selectedDirectory, "config.mjs"),
      name: "selected",
      path: join(selectedDirectory, "config.mjs"),
      source: "test",
    }, {
      handler: join(skippedDirectory, "config.mjs"),
      name: "skipped",
      path: join(skippedDirectory, "config.mjs"),
      source: "test",
    }], root, {
      root: join(root, ".vitehub", "workspaces"),
      store: { provider: "memory" },
      assets: ["selected"],
    }, registryFile)

    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default
    await expect(registry.selected.readFile("instructions/AGENTS.md")).resolves.toBe("# Selected\n")
    expect(registry.skipped).toBeUndefined()
  })

  it("does not fetch lazy sources while syncing build assets", async () => {
    const root = await createRoot()
    const directory = join(root, "server", "workspaces", "docs")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "config.mjs"), [
      "export default {",
      "  sources: {",
      "    docs: {",
      "      materialize: 'lazy',",
      "      async getKeys() { throw new Error('lazy source should not be fetched') },",
      "      async getItem() { throw new Error('lazy source should not be fetched') },",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(directory, "AGENTS.md"), "# Instructions\n")
    const registryFile = join(root, ".vitehub", "nitro-runtime", "workspace", "assets", "registry.mjs")
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("lazy source should not be fetched")
    }))

    await syncWorkspaceBuildAssets([{
      handler: join(directory, "config.mjs"),
      name: "docs",
      path: join(directory, "config.mjs"),
      source: "test",
    }], root, {
      root: join(root, ".vitehub", "workspaces"),
      store: { provider: "memory" },
      assets: true,
    }, registryFile)

    expect(fetch).not.toHaveBeenCalled()
    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default
    await expect(registry.docs.readFile("AGENTS.md")).rejects.toThrow("Workspace file does not exist")
  })

  it("reports inaccessible GitHub repositories with a source-specific error", async () => {
    stubGitHubSource({}, 404)

    const githubSource = source.github({
      repo: "acme/private",
      ref: "main",
      auth: "github-token",
    })

    await expect(githubSource.getKeys({ rootDir: "", workspace: "github-error" }))
      .rejects.toThrow("could not access the repository or ref \"main\"")
  })

  it("loads glob/file/custom sources and writes publish artifacts", async () => {
    const root = await createRoot()
    await writeFile(join(root, "one.md"), "# One\n")
    await writeFile(join(root, "skip.txt"), "skip\n")

    let customWrites = 0
    registerWorkspace("sources", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: source.glob({ cwd: ".", include: ["**/*.md"] }),
        files: source.file({ workspacePath: "two.md", content: "# Two\n" }),
        custom: source.custom({
          async getKeys() {
            return ["custom.json"]
          },
          async getItem(key) {
            return { key, path: key, data: { ok: true }, mediaType: "application/json" }
          },
        }),
      },
      loaders: [
        loader.files({
          exclude: ["skip.*"],
          transform(item) {
            customWrites++
            return item
          },
        }),
      ],
      publish: [
        publish.manifest({ path: "manifest.json" }),
        publish.types({ path: "workspace.d.ts" }),
      ],
    }))

    const workspace = useWorkspace("sources", { mode: "write" })
    await workspace.fs.list()
    await workspace.fs.list()

    expect(customWrites).toBe(3)
    expect(await workspace.fs.glob("**/*")).toHaveLength(3)
    expect(await readFile(join(root, "manifest.json"), "utf8")).toContain('"docs/one.md"')
    expect(await readFile(join(root, "workspace.d.ts"), "utf8")).toContain('#vitehub/workspaces/sources')
  })

  it("ignores hidden files, .git, and node_modules when discovering glob sources by default", async () => {
    const root = await createRoot()
    await mkdir(join(root, "node_modules/pkg"), { recursive: true })
    await mkdir(join(root, ".git/hooks"), { recursive: true })
    await writeFile(join(root, "visible.md"), "# Visible\n")
    await writeFile(join(root, ".hidden.md"), "# Hidden\n")
    await writeFile(join(root, "node_modules/pkg/hidden.md"), "# Hidden\n")
    await writeFile(join(root, ".git/hooks/pre-commit"), "hook\n")

    const keys = await source.glob({ cwd: ".", include: "**/*" }).getKeys({ rootDir: root, workspace: "glob-source" })

    expect(keys).toEqual(["visible.md"])
  })

  it("can include hidden glob source files explicitly", async () => {
    const root = await createRoot()
    await writeFile(join(root, "visible.md"), "# Visible\n")
    await writeFile(join(root, ".hidden.md"), "# Hidden\n")

    const keys = await source.glob({ cwd: ".", dot: true, include: "**/*" }).getKeys({ rootDir: root, workspace: "glob-source" })

    expect(keys).toEqual([".hidden.md", "visible.md"])
  })

  it("writes lazy workspace asset modules for text and binary files", async () => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub/assets/registry.mjs")
    const definition = defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: source.file({ content: "hello\n", workspacePath: "README.md" }),
        data: source.file({ content: new Uint8Array([1, 2, 3]), workspacePath: "data.bin" }),
      },
    })
    registerWorkspace("asset-bundle", definition)

    const store = createMemoryWorkspaceStore()
    await syncWorkspaceDefinition({ ...definition, name: "asset-bundle", store }, store)
    await writeWorkspaceAssetsRegistry(registryFile, [await collectWorkspaceStoreAssetBundle("asset-bundle", store)])

    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default

    await expect(registry["asset-bundle"].list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", type: "file" }),
      expect.objectContaining({ path: "data.bin", type: "file" }),
    ]))
    await expect(registry["asset-bundle"].readFile("README.md")).resolves.toBe("hello\n")
    await expect(registry["asset-bundle"].readFile("data.bin", { encoding: "binary" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await expect(registry["asset-bundle"].exists("../escape.txt")).resolves.toBe(false)
  })

  it("rejects unsafe workspace asset paths", async () => {
    const workspace = {
      name: "unsafe",
      async glob() {
        return [{ path: "../escape.txt", type: "file" }]
      },
      async readFile() {
        return "escape"
      },
    } as unknown as WorkspaceStore

    await expect(collectWorkspaceStoreAssetBundle("unsafe", workspace)).rejects.toThrow("escapes the workspace root")
  })
})
