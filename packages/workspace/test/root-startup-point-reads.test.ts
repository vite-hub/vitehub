import { describe, expect, it } from "vitest"

import { custom, file } from "../src/index.ts"
import { registerWorkspace, useWorkspace } from "../src/runtime.ts"
import { normalizeWorkspaceSourceMetadata, readWorkspaceSourceMaterializationStatus } from "../src/source-metadata.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe("root startup Source point reads", () => {
  const skillPath = ".agents/skills/foo/SKILL.md"

  for (const sourceKind of ["custom", "file"] as const) {
    for (const operation of ["readFile", "stat", "exists"] as const) {
      it(`${operation} finds the second root ${sourceKind} Source without preparation`, async () => {
        const createSource = (path: string, content: string) => sourceKind === "file"
          ? file({ content, materialize: "startup", mount: "", workspacePath: path })
          : custom({ files: [{ content, path }], materialize: "startup", mount: "" })
        const name = `root-startup-point-read-${crypto.randomUUID()}`
        registerWorkspace(name, {
          sources: {
            instructions: createSource("AGENTS.md", "# Instructions"),
            skills: createSource(skillPath, "# Foo"),
          },
          store: createMemoryWorkspaceStore(),
        })
        const { fs } = useWorkspace(name)

        if (operation === "readFile") {
          await expect(fs.readFile(skillPath, { encoding: "utf8" })).resolves.toBe("# Foo")
        }
        else if (operation === "stat") {
          await expect(fs.stat(skillPath)).resolves.toMatchObject({ path: skillPath, type: "file" })
        }
        else {
          await expect(fs.exists(skillPath)).resolves.toBe(true)
        }
        await expect(fs.readFile("AGENTS.md", { encoding: "utf8" })).resolves.toBe("# Instructions")
        await expect(fs.readFile(skillPath, { encoding: "utf8" })).resolves.toBe("# Foo")
      })
    }
  }
})

it.each(["", "shared"])("isolates same-key startup snapshots across Workspaces at mount %j", async (mount) => {
  const store = createMemoryWorkspaceStore()
  const first = `shared-source-first-${crypto.randomUUID()}`
  const second = `shared-source-second-${crypto.randomUUID()}`
  const source = (path: string) => custom({
    files: [{ path, content: path }],
    materialize: "startup",
    mount,
  })
  const path = (file: string) => [mount, file].filter(Boolean).join("/")
  registerWorkspace(first, { sources: { docs: source("first.md") }, store })
  const secondSource = source("second.md")
  registerWorkspace(second, { sources: { docs: secondSource }, store })

  await useWorkspace(first).fs.list("")
  await useWorkspace(second).fs.list("")
  await expect(store.readFile(path("first.md"))).resolves.toMatchObject({ content: "first.md", metadata: { source: "docs" } })
  await expect(store.readFile(path("second.md"))).resolves.toMatchObject({ content: "second.md", metadata: { source: "docs" } })

  registerWorkspace(first, { sources: { docs: source("updated.md") }, store })
  await useWorkspace(first).fs.list("")
  await expect(store.stat(path("first.md"))).resolves.toBeUndefined()
  await expect(store.readFile(path("updated.md"))).resolves.toMatchObject({ content: "updated.md" })
  await expect(store.readFile(path("second.md"))).resolves.toMatchObject({ content: "second.md" })
  await expect(readWorkspaceSourceMaterializationStatus(
    useWorkspace(second), normalizeWorkspaceSourceMetadata("docs", secondSource),
  )).resolves.toMatchObject({ status: "ready" })

  registerWorkspace(first, { sources: {}, store })
  await useWorkspace(first).fs.list("")
  await expect(store.stat(path("updated.md"))).resolves.toBeUndefined()
  await expect(store.readFile(path("second.md"))).resolves.toMatchObject({ content: "second.md" })
  await expect(useWorkspace(second).fs.readFile(path("second.md"), { encoding: "utf8" })).resolves.toBe("second.md")
})


it.each(["remove", "refresh"])("preserves another Workspace's same-key, same-path file on %s", async action => {
  const store = createMemoryWorkspaceStore()
  const first = `same-path-first-${crypto.randomUUID()}`
  const second = `same-path-second-${crypto.randomUUID()}`
  const source = (content: string) => custom({ files: [{ path: "shared.md", content }], materialize: "startup", mount: "" })
  registerWorkspace(first, { sources: { docs: source("first") }, store })
  registerWorkspace(second, { sources: { docs: source("second") }, store })
  await useWorkspace(first).fs.list("")
  await useWorkspace(second).fs.list("")
  await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "second" })

  registerWorkspace(first, { sources: action === "remove" ? {} : { docs: custom({ files: [], materialize: "startup", mount: "" }) }, store })
  await useWorkspace(first).fs.list("")
  await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "second" })
  await expect(useWorkspace(second, { refresh: false }).fs.readFile("shared.md", { encoding: "utf8" })).resolves.toBe("second")
})


it.each(["", "shared"])("revalidates inspection snapshot ownership at mount %j", async mount => {
  const store = createMemoryWorkspaceStore()
  const first = `inspection-first-${crypto.randomUUID()}`
  const second = `inspection-second-${crypto.randomUUID()}`
  const source = (content: string) => custom({ files: [{ path: "shared.md", content }], materialize: "startup", mount })
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  registerWorkspace(first, { sources: { docs: source("first") }, store })
  registerWorkspace(second, { sources: { docs: source("second") }, store })
  await useWorkspace(first).fs.list("")
  await useWorkspace(second).fs.list("")
  const inspection = useWorkspace(first, { mode: "read", refresh: false })
  await expect(inspection.fs.readFile(path, { encoding: "utf8" })).resolves.toBe("first")
  await useWorkspace(second, { refresh: false }).fs.readFile(path, { encoding: "utf8" })
  await expect(inspection.fs.readFile(path, { encoding: "utf8" })).resolves.toBe("first")
})
