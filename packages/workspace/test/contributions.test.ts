import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { collectWorkspaceContributions } from "../src/build/contributions.ts"
import { createWorkspaceRegistryContents, createWorkspaceVirtualRegistryContents, discoverViteWorkspaceDefinitions } from "../src/build/discovery.ts"
import { inspectWorkspaceDefinitions } from "../src/inspect.ts"
import { createWorkspaceNitroConfig, hubWorkspace } from "../src/vite.ts"

import type { WorkspaceContributingPlugin, WorkspaceContribution } from "../src/vite.ts"
import type { Plugin } from "vite"

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-contributions-"))
  tempDirs.push(root)
  await mkdir(join(root, "server", "workspaces"), { recursive: true })
  await writeFile(join(root, "server", "workspaces", "docs.ts"), "export default {}\n", "utf8")
  await mkdir(join(root, "node_modules", "content-owner"), { recursive: true })
  await writeFile(join(root, "node_modules", "content-owner", "package.json"), JSON.stringify({
    exports: { "./workspace": "./workspace.mjs" },
    name: "content-owner",
    type: "module",
  }))
  await writeFile(join(root, "node_modules", "content-owner", "workspace.mjs"), "export const contentWorkspace = { label: \"package content\" }\n")
  return root
}

function contributor(workspaces: NonNullable<WorkspaceContributingPlugin["vitehub"]>["workspaces"], name = "content-owner/vite"): WorkspaceContributingPlugin {
  return { name, vitehub: { workspaces } }
}

function hook<T extends (...args: never[]) => unknown>(value: unknown): T {
  const handler = value && typeof value === "object" && "handler" in value ? value.handler : value
  if (typeof handler !== "function") throw new TypeError("Expected a Vite hook.")
  // SAFETY: Each test passes the argument subset that the selected Workspace hook reads.
  return handler as T
}

const context = { projectRoot: "/app", rootDir: "/app" }

describe("collectWorkspaceContributions", () => {
  it("collects static and factory contributions from nested plugin options", async () => {
    const factory = vi.fn(() => [{ export: "cms", module: "/abs/cms.ts", name: "content" }])
    const contributions = await collectWorkspaceContributions([
      { name: "unrelated" },
      [contributor([{ module: "pkg/notes", name: "notes" }], "notes/vite"), [contributor(factory)]],
      false,
    ], { ...context, serverDirs: ["/app/server"] })

    expect(factory).toHaveBeenCalledWith({ projectRoot: "/app", rootDir: "/app", serverDirs: ["/app/server"] })
    expect(contributions).toEqual([
      { contributor: "notes/vite", module: "pkg/notes", name: "notes" },
      { contributor: "content-owner/vite", export: "cms", module: "/abs/cms.ts", name: "content" },
    ])
  })

  it("keeps one copy of an identical contribution and normalizes the default export", async () => {
    const plugin = contributor([{ module: "pkg/content", name: "content" }])
    const contributions = await collectWorkspaceContributions([
      plugin,
      plugin,
      contributor([{ export: "default", module: "pkg/content", name: "content" }], "other/vite"),
    ], context)

    expect(contributions).toEqual([{ contributor: "content-owner/vite", module: "pkg/content", name: "content" }])
  })

  it("rejects two different contributions with one name", async () => {
    await expect(collectWorkspaceContributions([
      contributor([{ module: "pkg/a", name: "content" }], "a/vite"),
      contributor([{ module: "pkg/b", name: "content" }], "b/vite"),
    ], context)).rejects.toMatchObject({
      code: "WORKSPACE_B0003",
      message: expect.stringContaining("Workspace \"content\" is defined more than once"),
    })
  })

  it.each([
    [{ module: "./relative.ts", name: "content" }, "is relative"],
    [{ module: "pkg/content", name: "" }, "`name` must be a non-empty string"],
    [{ name: "content" }, "needs a `module` string"],
    [{ export: "", module: "pkg/content", name: "content" }, "`export` must be a non-empty string"],
  ])("rejects an invalid contribution %#", async (contribution, message) => {
    await expect(collectWorkspaceContributions([contributor([contribution as WorkspaceContribution])], context)).rejects.toMatchObject({
      code: "WORKSPACE_B0004",
      message: expect.stringContaining(message),
    })
  })
})

describe("discoverViteWorkspaceDefinitions contributions", () => {
  it("merges contributed definitions with discovered files in name order", async () => {
    const root = await createRoot()

    expect(discoverViteWorkspaceDefinitions(root, {
      contributions: [
        { contributor: "content-owner/vite", export: "contentWorkspace", module: "content-owner/workspace", name: "content" },
        { module: "/abs/zeta.ts", name: "zeta" },
      ],
    })).toEqual([
      {
        contributor: "content-owner/vite",
        export: "contentWorkspace",
        handler: "content-owner/workspace",
        name: "content",
        path: "content-owner/workspace",
        source: "vite-plugin-contribution",
      },
      expect.objectContaining({ handler: join(root, "server", "workspaces", "docs.ts"), name: "docs" }),
      { handler: "/abs/zeta.ts", name: "zeta", path: "/abs/zeta.ts", source: "vite-plugin-contribution" },
    ])
  })

  it("fails when a contribution reuses a discovered Workspace name", async () => {
    const root = await createRoot()

    expect(() => discoverViteWorkspaceDefinitions(root, {
      contributions: [{ contributor: "content-owner/vite", module: "content-owner/workspace", name: "docs" }],
    })).toThrow(expect.objectContaining({
      code: "WORKSPACE_B0003",
      message: expect.stringContaining(join(root, "server", "workspaces", "docs.ts")),
    }))
  })

  it.each(["file", "virtual"] as const)("loads contributed exports from the %s registry", async (kind) => {
    const root = await createRoot()
    const registryFile = join(root, ".vitehub", "nitro", "workspace", "registry.mjs")
    await mkdir(join(root, ".vitehub", "nitro", "workspace"), { recursive: true })
    await mkdir(join(root, "owner"), { recursive: true })
    await writeFile(join(root, "owner", "workspace.mjs"), "export const fileWorkspace = { label: \"file content\" }\nexport const empty = undefined\n")
    const definitions = discoverViteWorkspaceDefinitions(root, {
      contributions: [
        { contributor: "content-owner/vite", export: "fileWorkspace", module: join(root, "owner", "workspace.mjs"), name: "content" },
        { contributor: "content-owner/vite", export: "empty", module: join(root, "owner", "workspace.mjs"), name: "empty" },
        { contributor: "content-owner/vite", export: "contentWorkspace", module: "content-owner/workspace", name: "package" },
      ],
    }).filter(definition => definition.name !== "docs")
    const contents = kind === "file"
      ? createWorkspaceRegistryContents(registryFile, definitions)
      : createWorkspaceVirtualRegistryContents(definitions)
    expect(contents).toContain("import(\"content-owner/workspace\")")
    await writeFile(registryFile, contents)

    const { default: registry }: { default: Record<string, () => Promise<{ default: { label: string } }>> } = await import(pathToFileURL(registryFile).href)

    await expect(registry.content!()).resolves.toEqual({ default: { label: "file content" } })
    await expect(registry.package!()).resolves.toEqual({ default: { label: "package content" } })
    await expect(registry.empty!()).rejects.toThrow("has no export \"empty\". Check the Workspace contribution of \"content-owner/vite\".")
  })

  it("applies resolved store overrides to contributed definitions", async () => {
    const root = await createRoot()
    const definitions = discoverViteWorkspaceDefinitions(root, { contributions: [{ module: "content-owner/workspace", name: "content" }] })
    const store = { binding: "CONTENT", namespace: "content", provider: "cloudflare-artifacts" }

    const contents = createWorkspaceRegistryContents(join(root, "registry.mjs"), definitions, new Map([["content", { store }]]))

    expect(contents).toContain("return { default: { ...definition, store: {\"binding\":\"CONTENT\"")
  })
})

describe("inspectWorkspaceDefinitions contributions", () => {
  it("lists contributed Workspaces with their contributor", async () => {
    const root = await createRoot()

    const summaries = await inspectWorkspaceDefinitions({
      plugins: [contributor([{ export: "contentWorkspace", module: "content-owner/workspace", name: "content" }])],
      projectRoot: root,
      rootDir: root,
      serverRootDir: root,
    })

    expect(summaries).toEqual([
      {
        fields: [
          { label: "Kind", value: "Contributed Workspace Definition" },
          { label: "Contributed by", value: "content-owner/vite" },
          { label: "Export", value: "contentWorkspace" },
        ],
        file: "content-owner/workspace",
        name: "content",
        source: "vite-plugin-contribution",
      },
      expect.objectContaining({ file: "server/workspaces/docs.ts", name: "docs" }),
    ])
  })
})

describe("hubWorkspace contributions", () => {
  it("adds contributed Workspaces to the Nitro registry, typegen, manifest, and inspection", async () => {
    const root = await createRoot()
    const owner = contributor(({ projectRoot }) => [{ export: "contentWorkspace", module: projectRoot === root ? "content-owner/workspace" : "wrong-root", name: "content" }])
    const plugin = hubWorkspace()
    const config = hook<(config: Record<string, unknown>, env: { command: "serve", mode: string }) => Promise<unknown>>(plugin.config)
    const configResolved = hook<(config: Record<string, unknown>) => Promise<void>>(plugin.configResolved)
    const resolveId = hook<(id: string) => string | undefined>(plugin.resolveId)
    const load = hook<(id: string) => string | undefined>(plugin.load)
    const userConfig = { nitro: {}, plugins: [[owner as Plugin]], root }

    await config(userConfig, { command: "serve", mode: "development" })
    expect(userConfig.nitro).toMatchObject({ plugins: [".vitehub/nitro/workspace/plugin.ts"] })
    const registrySource = await readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")
    expect(registrySource).toContain("[\"content\"]: async () => {")
    expect(registrySource).toContain("import(\"content-owner/workspace\")")
    expect(registrySource).toContain("mod[\"contentWorkspace\"]")

    await configResolved({ command: "serve", plugins: [plugin, owner], root })
    await expect(readFile(join(root, ".vitehub", "types", "workspace.d.ts"), "utf8")).resolves.toContain("\"content\": true")
    expect(plugin.api.getWorkspaces()).toEqual([{ name: "content" }, { name: "docs" }])
    expect(load(resolveId("#vitehub-workspace-registry")!)).toContain("import(\"content-owner/workspace\")")

    const inspect = plugin.vitehub!.inspect as () => Promise<{ definitions: Array<{ list: () => Promise<Array<{ name: string, source: string }>> }> }>
    const inspection = await inspect()
    await expect(inspection.definitions[0]!.list()).resolves.toEqual([
      expect.objectContaining({ name: "content", source: "vite-plugin-contribution" }),
      expect.objectContaining({ name: "docs" }),
    ])
  })

  it("fails the build when a contribution collides with a discovered Workspace", async () => {
    const root = await createRoot()
    const plugin = hubWorkspace()
    const config = hook<(config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<unknown>>(plugin.config)

    await expect(config({
      nitro: {},
      plugins: [contributor([{ module: "content-owner/workspace", name: "docs" }])],
      root,
    }, { command: "build", mode: "production" })).rejects.toMatchObject({ code: "WORKSPACE_B0003" })
  })

  it("adds contributed Workspaces to the Nuxt Nitro config", async () => {
    const root = await createRoot()
    await rm(join(root, "server", "workspaces", "docs.ts"))

    const nitro = await createWorkspaceNitroConfig({
      command: "build",
      nitro: {},
      plugins: [contributor([{ export: "contentWorkspace", module: "content-owner/workspace", name: "content" }])],
      viteRoot: root,
    })

    expect(nitro).toMatchObject({ plugins: [".vitehub/nitro/workspace/plugin.ts"] })
    await expect(readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")).resolves.toContain("[\"content\"]: async () => {")
  })
})
