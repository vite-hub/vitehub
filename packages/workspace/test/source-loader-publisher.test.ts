import { Buffer } from "node:buffer"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace, loader, publish, registerWorkspace, source, useWorkspace } from "../src/index.ts"
import type { WorkspaceStore } from "../src/types.ts"

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
      sources: [
        source.github({
          repo: "acme/app",
          root: "dbt",
          workspaceRoot: "acme/app/dbt",
        }),
      ],
      loaders: [loader.files()],
    }))

    const workspace = await useWorkspace("github-loader")
    await workspace.sync()

    await expect(workspace.readFile("acme/app/dbt/models/marts/orders.sql")).resolves.toBe("select 1\n")
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
      sources: [
        source.glob({ cwd: ".", include: ["**/*.md"] }),
        source.file({ path: "two.md", workspacePath: "two.md", content: "# Two\n" }),
        source.custom({
          name: "custom",
          async getKeys() {
            return ["custom.json"]
          },
          async getItem(key) {
            return { key, path: key, data: { ok: true }, mediaType: "application/json" }
          },
        }),
      ],
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

    const workspace = await useWorkspace("sources")
    await workspace.sync()
    await workspace.sync()

    expect(customWrites).toBe(6)
    expect(await workspace.glob("**/*")).toHaveLength(3)
    expect(await readFile(join(root, "manifest.json"), "utf8")).toContain('"one.md"')
    expect(await readFile(join(root, "workspace.d.ts"), "utf8")).toContain('virtual:vitehub/workspaces/sources')
  })

  it("keeps server assets inside the publish directory", async () => {
    const root = await createRoot()
    const store: WorkspaceStore = {
      async glob() {
        return [{ path: "../escape.txt", type: "file" }]
      },
      async readFile() {
        return { path: "../escape.txt", content: "escape" }
      },
      async list() {
        return []
      },
      async stat() {
        return undefined
      },
      async writeFile() {},
      async mkdir() {},
      async rm() {},
      async snapshot() {
        return { id: "snapshot", createdAt: new Date(0).toISOString(), entries: {} }
      },
      async diff() {
        return { to: "snapshot", entries: [] }
      },
    }

    await expect(publish.serverAssets({ dir: "server/assets" }).publish({
      workspace: { ...defineWorkspace({}), name: "escape" },
      store,
      rootDir: root,
    })).rejects.toThrow("escapes the workspace root")
  })

  it("cleans stale server assets before publishing", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server/assets/context"), { recursive: true })
    await writeFile(join(root, "server/assets/context/stale.txt"), "stale\n", "utf8")

    registerWorkspace("clean-assets", defineWorkspace({
      rootDir: root,
      store: { provider: "memory" },
      sources: [
        source.file({
          content: "fresh\n",
          path: "fresh.txt",
          workspacePath: "fresh.txt",
        }),
      ],
      loaders: [loader.files()],
      publish: [
        publish.serverAssets({ clean: true, dir: "server/assets/context" }),
      ],
    }))

    const workspace = await useWorkspace("clean-assets")
    await workspace.sync()

    await expect(readFile(join(root, "server/assets/context/fresh.txt"), "utf8")).resolves.toBe("fresh\n")
    await expect(access(join(root, "server/assets/context/stale.txt"))).rejects.toThrow()
  })
})
