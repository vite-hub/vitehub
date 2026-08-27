import type { Plugin } from "vite"
import type { Tool, ToolSet } from "ai"
import { describe, expectTypeOf, it } from "vitest"

import {
  defineWorkspace,
  sourceIgnores,
  useWorkspace,
} from "../src/index.ts"
import { createWorkspaceTools, type WorkspaceMaterializeSourcesResult, type WorkspaceShellResult } from "../src/ai.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import * as loader from "../src/loader.ts"
import * as publish from "../src/publish.ts"
import { custom, fetch, file, github, glob, markdown, mcpResources, source, type FetchSourceOptions, type GitHubSourceOptions, type GlobSourceOptions, type McpResourcesSourceOptions } from "../src/index.ts"
import { hubWorkspace } from "../src/vite.ts"
import type { GitHubWorkspaceStoreOptions, Workspace, WorkspaceModuleOptions, WorkspacePlugin, WorkspaceSourceSyncResult, WorkspaceWriteInput } from "../src/core/types.ts"

declare global {
  interface ViteHubWorkspaceAssetMap {
    typed: "AGENTS.md" | "README.md"
  }

  interface ViteHubWorkspaceSourceResolutionContextMap {
    channel: { meta?: { customer?: string } }
    "support.customerScope": { customers: Array<"acme" | "globex"> }
    pullRequest: { pullRequest: { source: { ref: string, repo: string } } }
  }

  interface ViteHubWorkspaceScopeNameMap {
    acme: true
    globex: true
    support: true
  }
}

describe("workspace types", () => {
  it("types custom file-list sources", () => {
    const docs = custom({
      files: [{
        content(context) {
          expectTypeOf(context.workspace).toEqualTypeOf<string>()
          return "# Guide\n"
        },
        path: "guides/start.md",
      }, {
        content: new Uint8Array([1, 2, 3]),
        mediaType: "application/octet-stream",
        metadata: { kind: "fixture" },
        path: "assets/example.bin",
      }],
      materialize: "lazy",
    })

    expectTypeOf(docs).toEqualTypeOf<import("../src/core/types.ts").WorkspaceSource>()
    // @ts-expect-error custom file content must be Workspace content or a lazy content callback
    custom({ files: [{ content: 42, path: "invalid.txt" }] })
  })

  it("exports source helper option types from the root", () => {
    const fetchOptions = { url: "https://status.example.com/api/summary" } satisfies FetchSourceOptions
    const githubOptions = { auth: false, repo: "acme/docs" } satisfies GitHubSourceOptions
    const globOptions = { include: "**/*.md" } satisfies GlobSourceOptions
    const mcpResourcesOptions = { server: { transport: { type: "http", url: "https://example.com/mcp" } } } satisfies McpResourcesSourceOptions
    const githubStoreOptions = { provider: "github", repository: "acme/app", token: () => "github-token" } satisfies GitHubWorkspaceStoreOptions

    expectTypeOf(fetchOptions).toMatchTypeOf<FetchSourceOptions>()
    expectTypeOf(githubOptions).toMatchTypeOf<GitHubSourceOptions>()
    expectTypeOf(globOptions).toMatchTypeOf<GlobSourceOptions>()
    expectTypeOf(mcpResourcesOptions).toMatchTypeOf<McpResourcesSourceOptions>()
    expectTypeOf(githubStoreOptions).toMatchTypeOf<GitHubWorkspaceStoreOptions>()
    expectTypeOf(source.github(githubOptions)).toMatchTypeOf(github(githubOptions))
  })

  it("does not expose a placeholder mount contract", () => {
    // SAFETY: This type-only fixture is never evaluated and exists to exercise the Workspace surface.
    const workspace = {} as Workspace
    // @ts-expect-error Workspace mounts require a real host projection contract.
    workspace.mount()
  })

  it("types the facade helpers", async () => {
    const definition = defineWorkspace({
      sources: {
        docs: markdown({ path: "README.md" }),
        externalDocs: {
          include: "**/*.md",
          sync: true,
        },
        githubDocs: {
          repo: "acme/docs",
          sync: { stale: "remove" },
        },
        wrappedDocs: {
          source: github({ repo: "acme/docs" }),
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
    // @ts-expect-error execution runtime belongs to Box
    defineWorkspace({ runtime: "trusted-host" })
    file({
      workspacePath: "AGENTS.md",
      content: "# Instructions\n",
    })
    file("AGENTS.md")
    // @ts-expect-error inline file content requires a workspacePath
    file({ content: "# Missing path\n" })
    // @ts-expect-error inline content cannot use a local file path
    file({ path: "AGENTS.md", content: "# Instructions\n" })
    github({
      repo: "acme/app",
      root: "docs",
      include: "**/*.md",
      ignore: "docs/drafts/**",
    })
    github({ ignore: sourceIgnores.defaults, repo: "acme/app" })
    defineWorkspace({
      sources: {
        docs: { ignore: false, repo: "acme/docs" },
      },
    })
    // @ts-expect-error Source Instructions no longer belong on Source config.
    github({ repo: "acme/app", instructions: "Use for hosted docs." })
    github(({ invocation, selectedWorkspaceScope, source: sourceContext, workspace }) => {
      expectTypeOf(invocation.context.get("support.customerScope")?.customers).toEqualTypeOf<Array<"acme" | "globex"> | undefined>()
      expectTypeOf(selectedWorkspaceScope?.name).toEqualTypeOf<"acme" | "globex" | "support" | undefined>()
      expectTypeOf(sourceContext.key).toEqualTypeOf<string>()
      expectTypeOf(workspace.name).toEqualTypeOf<string>()
      const customer = invocation.context.get("support.customerScope")?.customers[0]
      if (!customer) return false
      return {
        repo: "acme/app",
        root: `dbt/${customer}`,
        mount: `ingestion/${customer}`,
      }
    })
    github(({ channel, invocation }) => {
      expectTypeOf(channel?.meta?.customer).toEqualTypeOf<string | undefined>()
      expectTypeOf(invocation.context.get("pullRequest")?.pullRequest.source.repo).toEqualTypeOf<string | undefined>()
      return { root: "portal" }
    })
    glob({
      cwd: "docs",
      dot: true,
      followSymlinks: false,
      ignore: "drafts/**",
      include: "**/*.md",
      prefix: "content",
    })
    // @ts-expect-error Source Instructions no longer belong on Source config.
    glob({ include: "**/*.md", instructions: "Use for local docs." })
    fetch<{ status: string }, { ok: boolean }>({
      querySchema: {
        "~standard": {
          jsonSchema: {
            input: () => ({ type: "object" }),
          },
          // SAFETY: The type-only schema fixture models a validator accepting this record contract.
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
    fetch<{ status: string }>({
      // @ts-expect-error Workspace Sources do not own access scopes.
      scopes: ["support"] as const,
      transform(data) {
        return data
      },
      url: "https://status.example.com/api/summary",
      workspacePath: "status/summary.json",
    })
    fetch({
      body: { scope: "all" },
      cookies: { auth_token: "secret" },
      method: "POST",
      request: ({ request }) => ({
        headers: { "x-method": request.method },
        timeout: 1000,
      }),
      url: "https://status.example.com/query",
    })
    fetch<{ status: string }, { ok: boolean }>(({ invocation, selectedWorkspaceScope, source: sourceContext, workspace }) => {
      expectTypeOf(invocation.context.get("support.customerScope")?.customers).toEqualTypeOf<Array<"acme" | "globex"> | undefined>()
      expectTypeOf(selectedWorkspaceScope?.name).toEqualTypeOf<"acme" | "globex" | "support" | undefined>()
      expectTypeOf(sourceContext.key).toEqualTypeOf<string>()
      expectTypeOf(workspace.name).toEqualTypeOf<string>()
      if (!selectedWorkspaceScope) return null
      const customer = invocation.context.get("support.customerScope")?.customers[0]
      if (!customer) return false
      return {
        body: { customer },
        method: "POST",
        request: {
          headers: { "x-workspace": workspace.name },
        },
        transform(data) {
          expectTypeOf(data.status).toEqualTypeOf<string>()
          return { ok: data.status === "ok" }
        },
        url: `https://status.example.com/api/${sourceContext.key}`,
      }
    })
    // @ts-expect-error Source Instructions no longer belong on Source config.
    fetch({ instructions: "Use for live status.", url: "https://status.example.com" })
    mcpResources({
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
    // @ts-expect-error Source Instructions no longer belong on Source config.
    mcpResources({ instructions: "Use for MCP resource docs.", server: { listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }) } })
    // @ts-expect-error fetch does not expose public lifecycle hooks
    fetch({ url: "https://status.example.com/api/summary", beforeRequest() {} })
    // @ts-expect-error fetch uses workspacePath as its only Workspace-facing address
    fetch({ url: "https://status.example.com/api/summary", mount: "status" })
    // @ts-expect-error fetch uses workspacePath instead of path for Workspace placement
    fetch({ url: "https://status.example.com/api/summary", path: "status.json" })
    // @ts-expect-error fetch does not expose generic source validation mode
    fetch({ url: "https://status.example.com/api/summary", validate: "request" })
    // @ts-expect-error fetch request factories cannot redefine query
    fetch({ url: "https://status.example.com/api/summary", request: () => ({ query: { region: "eu" } }) })
    defineWorkspace({
      // @ts-expect-error workspace names are inferred from definition filenames
      name: "typed",
    })

    const readonly = useWorkspace("typed")
    const writable = useWorkspace("typed", { mode: "write" })
    // SAFETY: This type-only fixture is never evaluated and exists to exercise runtime-only methods.
    const runtimeWorkspace: Workspace = undefined!

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
    // @ts-expect-error read-only facade does not expose publication
    readonly.publish()
    expectTypeOf(writable.tools).toMatchTypeOf<ToolSet>()
    expectTypeOf(writable.tools.writeFile).toMatchTypeOf<Tool<{ content: string, mediaType?: string, path: string }, { path: string }>>()
    expectTypeOf(writable.tools.inspect().shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(writable.tools.write().writeFile).toMatchTypeOf<Tool<{ content: string, mediaType?: string, path: string }, { path: string }>>()
    expectTypeOf(writable.startSession).toBeFunction()
    expectTypeOf(writable.publish).toBeFunction()
    expectTypeOf(await writable.sync({ sources: ["externalDocs"] })).toMatchTypeOf<WorkspaceSourceSyncResult>()
    // @ts-expect-error workspace.sync requires explicit sources
    await runtimeWorkspace.sync()
    expectTypeOf(await runtimeWorkspace.sync({ sources: ["externalDocs"] })).toMatchTypeOf<WorkspaceSourceSyncResult>()
    expectTypeOf(await runtimeWorkspace.sync({ details: "paths", publish: true, snapshot: { message: "sync docs" }, sources: "all" })).toMatchTypeOf<WorkspaceSourceSyncResult>()
    const workspaceOptions: WorkspaceModuleOptions = { assets: ["typed"], store: { provider: "memory" } }
    const githubWorkspaceOptions: WorkspaceModuleOptions = { store: { branch: "main", provider: "github", repository: "acme/app", root: ".vitehub/workspaces/<workspace>" } }
    const lazyGithubWorkspaceOptions: WorkspaceModuleOptions = { store: { provider: "github", repository: () => "acme/app", token: () => "token" } }
    // @ts-expect-error Workspace Sources configure generated assets through assets.
    const removedOptions: WorkspaceModuleOptions = { syncOnBuild: true }
    expectTypeOf(workspaceOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    expectTypeOf(githubWorkspaceOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    expectTypeOf(lazyGithubWorkspaceOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    expectTypeOf(removedOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    // SAFETY: This type-only fixture is never evaluated and exists to exercise the session surface.
    const session: Awaited<ReturnType<typeof writable.startSession>> = undefined!
    // @ts-expect-error runtime selection belongs to Box, not Workspace session options
    await writable.startSession({ runtime: "local" })
    expectTypeOf(session.exec).toBeFunction()
    expectTypeOf(session.mkdir).toBeFunction()
    expectTypeOf(session.rm).toBeFunction()
    expectTypeOf(session.commit).toBeFunction()
    expectTypeOf(session.close).toBeFunction()
    await session.writeFile("README.md", "content", { mediaType: "text/markdown" })
    // @ts-expect-error session writes cannot promise store-level conditional semantics
    await session.writeFile("README.md", "content", { ifDigest: "baseline" })
    // @ts-expect-error session paths are already concrete host or overlay paths
    await session.writeFile("README.md", "content", { preservePath: true })
    expectTypeOf(await readonly.fs.readFile("AGENTS.md")).toEqualTypeOf<string>()
    // @ts-expect-error typed workspace assets reject unknown literal paths when no fallback string is declared
    await readonly.fs.readFile("MISSING.md")
    // @ts-expect-error read-only facade does not expose writes
    readonly.fs.writeFile("README.md", "nope")
    expectTypeOf(writable.fs.writeFile).toBeFunction()
    expectTypeOf(hubWorkspace()).toMatchTypeOf<Plugin>()
  })
})
