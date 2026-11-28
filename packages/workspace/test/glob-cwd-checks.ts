import { expect } from "vitest"
import type { WorkspaceStore } from "../src/core/types.ts"

export const globCwdPaths = ["root.md", "docs/readme.md", "docs/nested/guide.mdx", "docs/notes.txt", "docs-other/other.md", "docs[1]/literal.md"]

export async function seedGlobCwdStore(store: Pick<WorkspaceStore, "writeFile">): Promise<void> {
  for (const path of globCwdPaths) await store.writeFile(path, { path, content: path })
}

export async function checkGlobCwd(store: Pick<WorkspaceStore, "glob">): Promise<void> {
  expect((await store.glob("*.md", { cwd: "docs" })).map(entry => entry.path)).toEqual(["docs/readme.md"])
  expect((await store.glob(["*.md", "**/*.mdx"], { cwd: "docs/" })).map(entry => entry.path)).toEqual(["docs/nested/guide.mdx", "docs/readme.md"])
  expect((await store.glob("*.md", { cwd: "docs[1]" })).map(entry => entry.path)).toEqual(["docs[1]/literal.md"])
  expect((await store.glob("*.md")).map(entry => entry.path)).toEqual(["root.md"])
  expect((await store.glob("*.md", { cwd: "." })).map(entry => entry.path)).toEqual(["root.md"])
  await expect(store.glob("**/*", { cwd: "missing" })).resolves.toEqual([])
  await expect(store.glob("**/*", { cwd: "../docs" })).rejects.toThrow("is not a relative path inside the Workspace root")
}
