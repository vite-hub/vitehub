import { describe, expect, it } from "vitest"

import workspaceNuxt from "../src/nuxt.ts"

describe("Workspace Nuxt module", () => {
  it("registers collection composables once", () => {
    const nuxt = {
      options: {
        imports: {
          imports: [{ from: "@vite-hub/workspace/collections/client", name: "useWorkspaceCollection" }],
        },
        vite: { plugins: [] },
      },
    }

    workspaceNuxt({}, nuxt as never)
    workspaceNuxt({}, nuxt as never)

    expect(nuxt.options.imports.imports).toEqual([
      { from: "@vite-hub/workspace/collections/client", name: "useWorkspaceCollection" },
      { from: "@vite-hub/workspace/collections/client", name: "useWorkspaceCollectionItem" },
    ])
  })
})
