import { Buffer } from "node:buffer"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { collectWorkspaceAssetBundle, writeWorkspaceAssetsRegistry } from "../src/build-assets.ts"
import { defineWorkspace, loader, publish, registerWorkspace, source, useWorkspace } from "../src/index.ts"
import { useRegisteredWorkspace } from "../src/registry.ts"
import type { Workspace } from "../src/types.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-root-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  })
}

function stubGitHubSource(files: Record<string, string>, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const requestUrl = String(url)
    if (status !== 200) {
      return jsonResponse({ message: "not found" }, status)
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

    const path = decodeURIComponent(requestUrl.match(/contents\/(?<path>.+)\?ref/)?.groups?.path ?? "")
    return jsonResponse({
      content: Buffer.from(files[path] || "").toString("base64"),
      encoding: "base64",
    })
  }))
}

describe("sources, loaders, and publishers", () => {
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
          repo: "acme/app",
          root: "dbt",
        }),
      },
      loaders: [loader.files()],
    }))

    const workspace = useWorkspace("github-loader", { allowWrite: true })

    await expect(workspace.fs.readFile("docs/models/marts/orders.sql")).resolves.toBe("select 1\n")
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
        files: source.file({ path: "two.md", workspacePath: "two.md", content: "# Two\n" }),
        custom: source.custom({
          name: "custom",
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

    const workspace = useWorkspace("sources", { allowWrite: true })
    await workspace.fs.list()
    await workspace.fs.list()

    expect(customWrites).toBe(3)
    expect(await workspace.fs.glob("**/*")).toHaveLength(3)
    expect(await readFile(join(root, "manifest.json"), "utf8")).toContain('"docs/one.md"')
    expect(await readFile(join(root, "workspace.d.ts"), "utf8")).toContain('virtual:vitehub/workspaces/sources')
  })

  it("ignores .git and node_modules when discovering glob sources", async () => {
    const root = await createRoot()
    await mkdir(join(root, "node_modules/pkg"), { recursive: true })
    await mkdir(join(root, ".git/hooks"), { recursive: true })
    await writeFile(join(root, "visible.md"), "# Visible\n")
    await writeFile(join(root, "node_modules/pkg/hidden.md"), "# Hidden\n")
    await writeFile(join(root, ".git/hooks/pre-commit"), "hook\n")

    const keys = await source.glob({ cwd: ".", include: "**/*" }).getKeys({ rootDir: root, workspace: "glob-source" })

    expect(keys).toEqual(["visible.md"])
  })

  it("writes lazy workspace asset modules for text and binary files", async () => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub/assets/registry.mjs")
    registerWorkspace("asset-bundle", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: {
        docs: source.file({ content: "hello\n", path: "README.md", workspacePath: "README.md" }),
        data: source.file({ content: new Uint8Array([1, 2, 3]), path: "data.bin", workspacePath: "data.bin" }),
      },
    }))

    const workspace = await useRegisteredWorkspace("asset-bundle")
    await workspace.sync()
    await writeWorkspaceAssetsRegistry(registryFile, [await collectWorkspaceAssetBundle(workspace)])

    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default

    await expect(registry["asset-bundle"].list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "docs/README.md", type: "file" }),
      expect.objectContaining({ path: "data/data.bin", type: "file" }),
    ]))
    await expect(registry["asset-bundle"].readFile("docs/README.md")).resolves.toBe("hello\n")
    await expect(registry["asset-bundle"].readFile("data/data.bin", { encoding: "binary" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
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
    } as unknown as Workspace

    await expect(collectWorkspaceAssetBundle(workspace)).rejects.toThrow("escapes the workspace root")
  })
})
