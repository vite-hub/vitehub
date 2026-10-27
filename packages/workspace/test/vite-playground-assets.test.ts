import { resolve } from "node:path"

import { expect, it } from "vitest"

import { syncDiscoveredWorkspaceAssetBundles } from "../src/build/assets.ts"

it("builds the Vite playground README as a Workspace file", async () => {
  const rootDir = resolve(import.meta.dirname, "../../../playground/vite")
  const path = resolve(rootDir, "src/docs.workspace.ts")

  const bundles = await syncDiscoveredWorkspaceAssetBundles([{
    handler: path,
    name: "docs",
    path,
  }], rootDir, {
    root: resolve(rootDir, ".vitehub/workspaces"),
    store: { provider: "memory" },
    assets: true,
  })

  expect(bundles).toEqual([{
    name: "docs",
    files: [expect.objectContaining({
      path: "README.md",
      content: "# Vite playground workspace\n",
      mediaType: "text/markdown",
    })],
  }])
})
