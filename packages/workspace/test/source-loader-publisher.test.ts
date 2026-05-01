import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defineWorkspace, loader, publish, registerWorkspace, source, useWorkspace } from "../src/index.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-root-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("sources, loaders, and publishers", () => {
  it("loads glob/file/custom sources and writes publish artifacts", async () => {
    const root = await createRoot()
    await writeFile(join(root, "one.md"), "# One\n")
    await writeFile(join(root, "skip.txt"), "skip\n")

    let customWrites = 0
    registerWorkspace(defineWorkspace({
      name: "sources",
      rootDir: root,
      store: { provider: "memory" },
      sources: [
        source.glob({ cwd: ".", include: ["**/*.md"] }),
        source.file({ path: "two.md", workspacePath: "two.md", content: "# Two\n" }),
        source.custom({
          name: "custom",
          async getKeys() {
            return ["custom.json"]
          },
          async getItem(key) {
            return { key, path: key, data: { ok: true }, mediaType: "application/json" }
          },
        }),
      ],
      loaders: [
        loader.files({
          exclude: ["skip.*"],
          transform(item) {
            customWrites++
            return item
          },
        }),
      ],
      publish: [
        publish.manifest({ path: "manifest.json" }),
        publish.types({ path: "workspace.d.ts" }),
      ],
    }))

    const workspace = await useWorkspace("sources")
    await workspace.sync()
    await workspace.sync()

    expect(customWrites).toBe(6)
    expect(await workspace.glob("**/*")).toHaveLength(3)
    expect(await readFile(join(root, "manifest.json"), "utf8")).toContain('"one.md"')
    expect(await readFile(join(root, "workspace.d.ts"), "utf8")).toContain('virtual:vitehub/workspaces/sources')
  })
})
