import type { Plugin } from "vite"
import type { Tool, ToolSet } from "ai"
import { describe, expectTypeOf, it } from "vitest"

import {
  defineWorkspace,
  useWorkspace,
} from "../src/index.ts"
import { createWorkspaceTools, type WorkspaceMaterializeSourcesResult, type WorkspaceShellResult } from "../src/ai.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import * as loader from "../src/loader.ts"
import * as publish from "../src/publish.ts"
import { source } from "../src/index.ts"
import { hubWorkspace } from "../src/vite.ts"
import type { Workspace, WorkspaceModuleOptions, WorkspacePlugin, WorkspaceSourceSyncResult, WorkspaceWriteInput } from "../src/core/types.ts"

declare global {
  interface ViteHubWorkspaceAssetMap {
    typed: "AGENTS.md" | "README.md"
  }
}

describe("workspace types", () => {
  it("types the facade helpers", async () => {
    const definition = defineWorkspace({
      runtime: "sandbox",
      sources: {
        docs: source.markdown({ path: "README.md" }),
        externalDocs: {
          include: "**/*.md",
          sync: true,
        },
        githubDocs: {
          repo: "acme/docs",
          sync: { stale: "remove" },
        },
        wrappedDocs: {
          source: source.github({ repo: "acme/docs" }),
          sync: true,
        },
      },
      loaders: [loader.files()],
      publish: [
        publish.virtualModule({ id: "#vitehub/workspaces/typed" }),
        publish.github({ repo: "acme/app", token: () => "github-token" }),
      ],
      rules: {
        "/**": { write: false },
        "/generated/**": {
          maxBytes: "1mb",
          validate: (input: WorkspaceWriteInput) => input,
          write: true,
        },
      },
      hooks: {
        "write:before": (ctx) => {
          expectTypeOf(ctx.path).toEqualTypeOf<string>()
        },
      },
      plugins: [{
        id: "typed-plugin",
        rules: { "/docs/**": { write: "update" } },
      } satisfies WorkspacePlugin],
    })
    source.file({
      workspacePath: "AGENTS.md",
      content: "# Instructions\n",
    })
    source.file("AGENTS.md")
    // @ts-expect-error inline file content requires a workspacePath
    source.file({ content: "# Missing path\n" })
    // @ts-expect-error inline content cannot use a local file path
    source.file({ path: "AGENTS.md", content: "# Instructions\n" })
    source.github({
      repo: "acme/app",
      root: "docs",
      include: "**/*.md",
      exclude: "docs/drafts/**",
      instructions: "Use for hosted docs.",
    })
    source.github(({ invocation, selectedWorkspaceScope, source: sourceContext, workspace }) => {
      expectTypeOf(invocation.context.get<{ customers: string[] }>("support.customerScope")?.customers).toEqualTypeOf<string[] | undefined>()
      expectTypeOf(selectedWorkspaceScope?.scope).toEqualTypeOf<string | undefined>()
      expectTypeOf(sourceContext.key).toEqualTypeOf<string>()
      expectTypeOf(workspace.name).toEqualTypeOf<string>()
      const customer = invocation.context.get<{ customers: string[] }>("support.customerScope")?.customers[0]
      if (!customer) return false
      return {
        repo: "acme/app",
        root: `dbt/${customer}`,
        mount: `ingestion/${customer}`,
        instructions: [`Use for ${customer} ingestion models.`],
      }
    })
    source.glob({
      cwd: "docs",
      dot: true,
      followSymlinks: false,
      ignore: "drafts/**",
      include: "**/*.md",
      instructions: ["Use for local docs.", "Prefer README files first."] as const,
      prefix: "content",
    })
    source.fetch<{ status: string }, { ok: boolean }>({
      instructions: "Use for live status.",
      querySchema: {
        "~standard": {
          jsonSchema: {
            input: () => ({ type: "object" }),
          },
          validate: (input: unknown) => ({ value: input as Record<string, unknown> }),
        },
      },
      transform(data) {
        expectTypeOf(data.status).toEqualTypeOf<string>()
        return { ok: data.status === "ok" }
      },
      url: "https://status.example.com/api/summary",
      workspacePath: "status/summary.json",
    })
    source.fetch({
      body: { scope: "all" },
      cookies: { auth_token: "secret" },
      method: "POST",
      request: ({ request }) => ({
        headers: { "x-method": request.method },
        timeout: 1000,
      }),
      url: "https://status.example.com/query",
    })
    source.mcpResources({
      instructions: "Use for MCP resource docs.",
      mount: "nuxt",
      server: {
        async listResources() {
          return { resources: [] }
        },
        async readResource() {
          return { contents: [] }
        },
      },
    })
    // @ts-expect-error source.fetch does not expose public lifecycle hooks
    source.fetch({ url: "https://status.example.com/api/summary", beforeRequest() {} })
    // @ts-expect-error source.fetch uses workspacePath as its only Workspace-facing address
    source.fetch({ url: "https://status.example.com/api/summary", mount: "status" })
    // @ts-expect-error source.fetch uses workspacePath instead of path for Workspace placement
    source.fetch({ url: "https://status.example.com/api/summary", path: "status.json" })
    // @ts-expect-error source.fetch does not expose generic source validation mode
    source.fetch({ url: "https://status.example.com/api/summary", validate: "request" })
    // @ts-expect-error source.fetch request factories cannot redefine query
    source.fetch({ url: "https://status.example.com/api/summary", request: () => ({ query: { region: "eu" } }) })
    // @ts-expect-error source.fetch definitions are static; only request credentials may be dynamic
    source.fetch(() => ({ url: "https://status.example.com/api/summary" }))
    defineWorkspace({
      // @ts-expect-error workspace names are inferred from definition filenames
      name: "typed",
    })

    const readonly = useWorkspace("typed")
    const writable = useWorkspace("typed", { mode: "write" })
    const runtimeWorkspace = null as unknown as Workspace

    expectTypeOf(definition).toMatchTypeOf<object>()
    expectTypeOf(createWorkspaceTools(createWorkspaceAssets({
      "README.md": { load: async () => "# Docs\n" },
    })).shell).toMatchTypeOf<object>()
    expectTypeOf(readonly.tools).toMatchTypeOf<ToolSet>()
    expectTypeOf(readonly.tools.shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(readonly.tools.inspect().shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(readonly.tools.inspect({ materialize: true }).materialize_sources).toMatchTypeOf<Tool<{ path?: string, sources?: string[] }, WorkspaceMaterializeSourcesResult>>()
    expectTypeOf(readonly.tools.none()).toMatchTypeOf<ToolSet>()
    // @ts-expect-error workspace tools are no longer callable aliases
    readonly.tools()
    // @ts-expect-error read-only facade does not expose executable write sessions
    readonly.startSession()
    // @ts-expect-error read-only facade does not expose Source Sync
    readonly.sync({ sources: ["externalDocs"] })
    expectTypeOf(writable.tools).toMatchTypeOf<ToolSet>()
    expectTypeOf(writable.tools.writeFile).toMatchTypeOf<Tool<{ content: string, mediaType?: string, path: string }, { path: string }>>()
    expectTypeOf(writable.tools.inspect().shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(writable.tools.write().writeFile).toMatchTypeOf<Tool<{ content: string, mediaType?: string, path: string }, { path: string }>>()
    expectTypeOf(writable.startSession).toBeFunction()
    expectTypeOf(await writable.sync({ sources: ["externalDocs"] })).toMatchTypeOf<WorkspaceSourceSyncResult>()
    // @ts-expect-error workspace.sync requires explicit sources
    await runtimeWorkspace.sync()
    expectTypeOf(await runtimeWorkspace.sync({ sources: ["externalDocs"] })).toMatchTypeOf<WorkspaceSourceSyncResult>()
    expectTypeOf(await runtimeWorkspace.sync({ details: "paths", publish: true, snapshot: { message: "sync docs" }, sources: "all" })).toMatchTypeOf<WorkspaceSourceSyncResult>()
    const workspaceOptions: WorkspaceModuleOptions = { assets: ["typed"], store: { provider: "memory" } }
    const githubWorkspaceOptions: WorkspaceModuleOptions = { store: { branch: "main", provider: "github", repository: "acme/app", root: ".vitehub/workspaces/<workspace>" } }
    // @ts-expect-error syncOnBuild was removed in favor of assets
    const removedOptions: WorkspaceModuleOptions = { syncOnBuild: true }
    expectTypeOf(workspaceOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    expectTypeOf(githubWorkspaceOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    expectTypeOf(removedOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    const session = null as unknown as Awaited<ReturnType<typeof writable.startSession>>
    // @ts-expect-error runtime selection belongs in workspace config, not open options
    await writable.startSession({ runtime: "local" })
    expectTypeOf(session.exec).toBeFunction()
    expectTypeOf(session.commit).toBeFunction()
    expectTypeOf(session.close).toBeFunction()
    expectTypeOf(await readonly.fs.readFile("AGENTS.md")).toEqualTypeOf<string>()
    // @ts-expect-error typed workspace assets reject unknown literal paths when no fallback string is declared
    await readonly.fs.readFile("MISSING.md")
    // @ts-expect-error read-only facade does not expose writes
    readonly.fs.writeFile("README.md", "nope")
    expectTypeOf(writable.fs.writeFile).toBeFunction()
    expectTypeOf(hubWorkspace()).toMatchTypeOf<Plugin>()
  })
})
