import { expect, it } from "vitest"
import { readBuiltWorkspaceImports } from "../../internal/test-utils/built-workspace-imports.js"

it("keeps the built server off the Workspace Agent tool graph", async () => {
  const graph = await readBuiltWorkspaceImports(new URL("../dist/server.js", import.meta.url))
  expect(graph.imports).toEqual(["@vite-hub/workspace/files", "@vite-hub/workspace/internal/path"])
  expect(graph.code).not.toContain("maxShellCalls")
  expect(graph.code).not.toContain("@vite-hub/shell/workspace")
})
