import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"
import type { Tool } from "ai"
import { describe, expectTypeOf, it } from "vitest"

import {
  defineWorkspace,
  loader,
  publish,
  useWorkspace,
} from "../src/index.ts"
import * as source from "../src/source.ts"
import { hubWorkspace } from "../src/vite.ts"

declare global {
  interface ViteHubWorkspaceAssetMap {
    typed: "AGENTS.md" | "README.md"
  }
}

describe("workspace types", () => {
  it("types the facade helpers", async () => {
    const definition = defineWorkspace({
      sources: { docs: source.markdown({ path: "README.md" }) },
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
    })
    defineWorkspace({
      // @ts-expect-error workspace names are inferred from definition filenames
      name: "typed",
    })

    const readonly = useWorkspace("typed")
    const writable = useWorkspace("typed", { allowWrite: true })

    expectTypeOf(definition).toMatchTypeOf<object>()
    expectTypeOf((await readonly.tools()).readFile).toMatchTypeOf<Tool<{ path: string }, { content: string, path: string }>>()
    expectTypeOf((await writable.tools()).writeFile).toMatchTypeOf<Tool<{ content: string, mediaType?: string, path: string }, { path: string }>>()
    expectTypeOf(await readonly.fs.readFile("AGENTS.md")).toEqualTypeOf<string>()
    // @ts-expect-error typed workspace assets reject unknown literal paths when no fallback string is declared
    await readonly.fs.readFile("MISSING.md")
    // @ts-expect-error read-only facade does not expose writes
    readonly.fs.writeFile("README.md", "nope")
    expectTypeOf(writable.fs.writeFile).toBeFunction()
    expectTypeOf(hubWorkspace()).toMatchTypeOf<Plugin & { nitro: NitroModule }>()
  })
})
