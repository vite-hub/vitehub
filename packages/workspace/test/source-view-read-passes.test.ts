import { expect, it } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

import type { WorkspaceStore } from "../src/core/types.ts"

function countingStore() {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  const calls: { method: "getMeta" | "readFile" | "stat", path: string }[] = []
  const readFile = store.readFile.bind(store)
  const stat = store.stat.bind(store)
  const getMeta = store.getMeta!.bind(store)
  store.readFile = async (path) => {
    calls.push({ method: "readFile", path })
    return await readFile(path)
  }
  store.stat = async (path) => {
    calls.push({ method: "stat", path })
    return await stat(path)
  }
  store.getMeta = async (key) => {
    calls.push({ method: "getMeta", path: key })
    return await getMeta(key)
  }
  return {
    calls: (path: string) => calls.filter(call => call.path === path || call.path.includes(path)).map(call => call.method),
    reset: () => calls.splice(0),
    store,
  }
}

it("reads a Workspace file once when no Source can own it", async () => {
  const { calls, reset, store } = countingStore()
  await store.writeFile("README.md", { path: "README.md", content: "# Docs" })
  const view = createWorkspaceSourceView({ name: "docs" }, store)
  reset()

  await expect(view.readFile("README.md")).resolves.toBe("# Docs")

  expect(calls("README.md")).toEqual(["readFile"])
})

it("checks root startup ownership before it reads file content", async () => {
  const { calls, reset, store } = countingStore()
  const view = createWorkspaceSourceView({
    name: "docs",
    sources: { instructions: custom({ files: [{ content: "# Instructions", path: "AGENTS.md" }], materialize: "startup", mount: "" }) },
  }, store)
  await expect(view.readFile("AGENTS.md")).resolves.toBe("# Instructions")
  await store.writeFile("notes.md", { path: "notes.md", content: "notes" })
  reset()

  await expect(view.readFile("notes.md")).resolves.toBe("notes")
  expect(calls("notes.md").filter(method => method !== "getMeta")).toEqual(["readFile"])

  reset()
  await expect(view.readFile("AGENTS.md")).resolves.toBe("# Instructions")
  // A Source-owned file still verifies its bytes against the owner digest.
  expect(calls("AGENTS.md")).toEqual(expect.arrayContaining(["getMeta", "stat", "readFile"]))
})

it("keeps another Workspace's root startup file outside this Workspace's ownership", async () => {
  const store = createMemoryWorkspaceStore()
  const source = (content: string) => custom({ files: [{ content, path: "shared.md" }], materialize: "startup", mount: "" })
  const first = createWorkspaceSourceView({ name: "first", sources: { shared: source("first") } }, store)
  const second = createWorkspaceSourceView({ name: "second", sources: { shared: source("second") } }, store)

  await expect(first.readFile("shared.md")).resolves.toBe("first")
  await expect(second.readFile("shared.md")).resolves.toBe("second")
  await expect(first.readFile("shared.md")).resolves.toBe("first")
})
