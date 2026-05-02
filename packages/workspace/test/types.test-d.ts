import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"
import type { Tool } from "ai"
import { describe, expectTypeOf, it } from "vitest"

import {
  defineWorkspace,
  loader,
  publish,
  source,
  useWorkspace,
  type Workspace,
} from "../src/index.ts"
import { createWorkspaceTools, readWorkspaceInstructions, useWorkspaceTools, type WorkspaceShellResult } from "../src/ai.ts"
import { hubWorkspace } from "../src/vite.ts"

describe("workspace types", () => {
  it("types public helpers", async () => {
    const definition = defineWorkspace({
      sources: [source.markdown({ path: "README.md" })],
      loaders: [loader.files()],
      publish: [publish.virtualModule({ id: "virtual:vitehub/workspaces/typed" })],
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
      workspaceRoot: "acme/app/docs",
    })
    defineWorkspace({
      // @ts-expect-error workspace names are inferred from definition filenames
      name: "typed",
    })

    expectTypeOf(definition).toMatchTypeOf<object>()
    expectTypeOf(createWorkspaceTools({
      async getKeys() {
        return ["README.md"]
      },
      async getItem<T>() {
        return "# Docs\n" as T
      },
    }).bash).toMatchTypeOf<object>()
    expectTypeOf(useWorkspaceTools("typed").bash).toMatchTypeOf<Tool<{ command: string }, WorkspaceShellResult>>()
    expectTypeOf(useWorkspaceTools("typed").readFile).toMatchTypeOf<Tool<{ path: string }, string>>()
    expectTypeOf(await readWorkspaceInstructions({
      async getKeys() {
        return ["AGENTS.md"]
      },
      async getItem<T>() {
        return "# Instructions\n" as T
      },
    })).toMatchTypeOf<string>()
    expectTypeOf(await useWorkspace("typed")).toMatchTypeOf<Workspace>()
    expectTypeOf(hubWorkspace()).toMatchTypeOf<Plugin & { nitro: NitroModule }>()
  })
})
