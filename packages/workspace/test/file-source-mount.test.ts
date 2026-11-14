import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { file as sourceFile, markdown as sourceMarkdown } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { decodeFile } from "../src/core/path.ts"
import { file, markdown } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { normalizeWorkspaceSource, workspaceSourceGrantPaths } from "../src/sources/config.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

import type { WorkspaceDefinition } from "../src/core/types.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-file-mount-"))
  await writeFile(join(root, "README.md"), "# Readme\n")
  await writeFile(join(root, "NOTES.md"), "# Notes\n")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function materialize(sources: WorkspaceDefinition["sources"]) {
  const store = createMemoryWorkspaceStore()
  await syncWorkspaceDefinition({ name: "file-mounts", sourceRootDir: root, sources }, store)
  const paths = (await store.glob("**/*")).map(entry => entry.path).filter(path => !path.startsWith(".vitehub/")).sort()
  const read = async (path: string) => {
    const stored = await store.readFile(path)
    return stored ? decodeFile(stored.content) : undefined
  }
  return { paths, read }
}

describe("file Source mounts", () => {
  it("places a file at its own path for every file helper", async () => {
    const workspace = await materialize({
      readme: file("README.md"),
      notes: sourceFile("NOTES.md"),
      guide: markdown({ path: "README.md", workspacePath: "guide.md" }),
      intro: sourceMarkdown({ path: "NOTES.md", workspacePath: "intro.md" }),
    })

    expect(workspace.paths).toEqual(["NOTES.md", "README.md", "guide.md", "intro.md"])
    await expect(workspace.read("NOTES.md")).resolves.toBe("# Notes\n")
    await expect(workspace.read("README.md")).resolves.toBe("# Readme\n")
  })

  it("resolves the same mount and grant paths for both file imports", () => {
    for (const source of [file("docs/README.md"), sourceFile("docs/README.md")]) {
      expect(normalizeWorkspaceSource("readme", source)).toMatchObject({ mountPath: "", probeKeys: ["docs/README.md"] })
      expect(workspaceSourceGrantPaths("readme", source)[0]).toBe("docs/README.md")
    }
  })

  it("moves a file only with an explicit mount", async () => {
    const workspace = await materialize({
      readme: { source: sourceFile("README.md"), mount: "docs" },
      notes: { source: file("NOTES.md"), mount: "docs" },
    })

    expect(workspace.paths).toEqual(["docs/NOTES.md", "docs/README.md"])
    expect(workspaceSourceGrantPaths("readme", { source: sourceFile("README.md"), mount: "docs" })[0]).toBe("docs/README.md")
  })
})
