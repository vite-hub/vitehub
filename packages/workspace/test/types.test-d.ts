import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"
import type { Tool, ToolSet } from "ai"
import { describe, expectTypeOf, it } from "vitest"

import {
  defineWorkspace,
  loader,
  publish,
  useWorkspace,
} from "../src/index.ts"
import { createWorkspaceTools, type WorkspaceMaterializeSourcesResult, type WorkspaceShellResult } from "../src/ai.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"
import * as source from "../src/source.ts"
import { hubWorkspace } from "../src/vite.ts"
import type { WorkspaceModuleOptions, WorkspacePlugin, WorkspaceWriteInput } from "../src/types.ts"

declare global {
  interface ViteHubWorkspaceAssetMap {
    typed: "AGENTS.md" | "README.md"
  }
}

describe("workspace types", () => {
  it("types the facade helpers", async () => {
    const definition = defineWorkspace({
      runtime: "sandbox",
      sources: { docs: source.markdown({ path: "README.md" }) },
      loaders: [loader.files()],
      publish: [publish.virtualModule({ id: "#vitehub/workspaces/typed" })],
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
    // @ts-expect-error inline file content requires a workspacePath
    source.file({ content: "# Missing path\n" })
    source.github({
      repo: "acme/app",
      root: "docs",
      include: "**/*.md",
      exclude: "docs/drafts/**",
    })
    source.glob({
      cwd: "docs",
      dot: true,
      followSymlinks: false,
      ignore: "drafts/**",
      include: "**/*.md",
      prefix: "content",
    })
    defineWorkspace({
      // @ts-expect-error workspace names are inferred from definition filenames
      name: "typed",
    })

    const readonly = useWorkspace("typed")
    const writable = useWorkspace("typed", { allowWrite: true })

    expectTypeOf(definition).toMatchTypeOf<object>()
    expectTypeOf(createWorkspaceTools(createWorkspaceAssets({
      "README.md": { load: async () => "# Docs\n" },
    })).shell).toMatchTypeOf<object>()
    expectTypeOf(readonly.tools).toMatchTypeOf<ToolSet>()
    expectTypeOf(readonly.tools().shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(readonly.tools.inspect().shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(readonly.tools.inspect({ materialize: true }).materialize_sources).toMatchTypeOf<Tool<{ path?: string, sources?: string[] }, WorkspaceMaterializeSourcesResult>>()
    expectTypeOf(readonly.tools.readonly().shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(readonly.tools.none()).toMatchTypeOf<ToolSet>()
    expectTypeOf(readonly.tools()).toMatchTypeOf<ToolSet>()
    // @ts-expect-error read-only facade does not expose executable write sessions
    readonly.open()
    expectTypeOf(writable.tools).toMatchTypeOf<ToolSet>()
    expectTypeOf(writable.tools().writeFile).toMatchTypeOf<Tool<{ content: string, mediaType?: string, path: string }, { path: string }>>()
    expectTypeOf(writable.tools.inspect().shell).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(writable.tools.write().writeFile).toMatchTypeOf<Tool<{ content: string, mediaType?: string, path: string }, { path: string }>>()
    expectTypeOf(writable.open).toBeFunction()
    const workspaceOptions: WorkspaceModuleOptions = { assets: ["typed"], store: { provider: "memory" } }
    // @ts-expect-error syncOnBuild was removed in favor of assets
    const removedOptions: WorkspaceModuleOptions = { syncOnBuild: true }
    expectTypeOf(workspaceOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    expectTypeOf(removedOptions).toMatchTypeOf<WorkspaceModuleOptions>()
    const session = null as unknown as Awaited<ReturnType<import("../src/types.ts").Workspace["open"]>>
    const workspace = null as unknown as import("../src/types.ts").Workspace
    // @ts-expect-error runtime selection belongs in workspace config, not open options
    await workspace.open({ runtime: "local" })
    expectTypeOf(session.exec).toBeFunction()
    expectTypeOf(session.commit).toBeFunction()
    expectTypeOf(session.close).toBeFunction()
    expectTypeOf(await readonly.fs.readFile("AGENTS.md")).toEqualTypeOf<string>()
    // @ts-expect-error typed workspace assets reject unknown literal paths when no fallback string is declared
    await readonly.fs.readFile("MISSING.md")
    // @ts-expect-error read-only facade does not expose writes
    readonly.fs.writeFile("README.md", "nope")
    expectTypeOf(writable.fs.writeFile).toBeFunction()
    expectTypeOf(hubWorkspace()).toMatchTypeOf<Plugin & { nitro: NitroModule }>()
  })
})
