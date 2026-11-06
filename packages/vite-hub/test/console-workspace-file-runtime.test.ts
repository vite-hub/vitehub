import { expect, it } from "vitest"
import { readBuiltWorkspaceImports } from "../../internal/test-utils/built-workspace-imports.js"

it.each([
  ["Console", "../dist/console/runtime/server/invocation-workspace.get.js"],
  ["framework", "../dist/workspace/files.js"],
])("keeps built %s file access off the Workspace Agent tool graph", async (_name, entry) => {
  const graph = await readBuiltWorkspaceImports(new URL(entry, import.meta.url))
  expect(graph.imports).toEqual(["@vite-hub/workspace/files"])
  expect(graph.code).not.toContain("maxShellCalls")
  expect(graph.code).not.toContain("@vite-hub/shell/workspace")
})
