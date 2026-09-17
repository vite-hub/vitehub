import { describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

describe("startup snapshot precedence", () => {
  it.each(["local", "memory without CAS", "memory without attributes"].flatMap(provider => [false, true].map(missingSnapshot => ({ provider, missingSnapshot }))))("recovers lower-only files on $provider with missing snapshot=$missingSnapshot", async ({ provider, missingSnapshot }) => {
    const root = await mkdtemp(join(tmpdir(), "startup-precedence-"))
    try {
      const store = provider === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
      store.compareAndSwapFile = undefined
      if (provider === "memory without attributes") {
        const writeFile = store.writeFile.bind(store)
        store.writeFile = async (path, file) => await writeFile(path, { path, content: file.content })
      }
      const preservedContent = provider === "memory without attributes" ? "lower" : "preserved higher"
      let higherContent = preservedContent
      let lowerKeys = ["shared.md", "missing.md"]
      const higherItem = vi.fn(async (key: string) => ({ key, content: higherContent }))
      const lowerItem = vi.fn(async (key: string) => ({ key, content: "lower" }))
      const definition = {
        name: "startup-precedence-without-cas",
        sources: {
          higher: custom({ materialize: "startup", mount: "", async getKeys() { return ["shared.md"] }, getItem: higherItem }),
          lower: custom({ materialize: "startup", mount: "", cache: { maxAge: 3600 }, async getKeys() { return lowerKeys }, getItem: lowerItem }),
        },
      }
      await createWorkspaceSourceView(definition, store).list("")
      higherContent = "new higher provider content"
      await store.rm("missing.md")
      lowerKeys = [...lowerKeys, "new.md"]
      if (missingSnapshot) await store.setMeta?.(sourceSnapshotMetaKey("lower", definition.name), {})
      const writes = vi.spyOn(store, "writeFile")
      const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
      await inspection.list("")
      for (const [path, expected] of [["shared.md", preservedContent], ["missing.md", "lower"], ["new.md", "lower"]] as const) {
        const file = await store.readFile(path)
        expect(Buffer.from(file?.content ?? "").toString("utf8")).toBe(expected)
      }
      expect(writes.mock.calls.some(([path]) => path === "shared.md")).toBe(false)
      expect(higherItem).toHaveBeenCalledTimes(1)
      const recoveredCalls = lowerItem.mock.calls.length
      await inspection.list("")
      await createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true }).list("")
      expect(higherItem).toHaveBeenCalledTimes(1)
      expect(lowerItem).toHaveBeenCalledTimes(recoveredCalls)
      Reflect.deleteProperty(definition.sources, "higher")
      await store.rm("shared.md")
      const retired = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
      await expect(retired.readFile("shared.md", { encoding: "utf8" })).resolves.toBe("lower")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([false, true].flatMap(fileMetadata => ["none", "foreign owner", "concurrent content", "concurrent metadata", "concurrent mediaType"].map(replacement => ({ fileMetadata, replacement }))))("recovers startup snapshots with file metadata=$fileMetadata and replacement=$replacement", async ({ fileMetadata, replacement }) => {
    const store = createMemoryWorkspaceStore()
    const writeFile = store.writeFile.bind(store)
    if (!fileMetadata) {
      const writeFileConditional = store.writeFileConditional!.bind(store)
      store.writeFile = async (path, file) => await writeFile(path, { path: file.path, content: file.content })
      store.writeFileConditional = async (path, file, ifDigest) => await writeFileConditional(path, { path: file.path, content: file.content }, ifDigest)
    }
    let higherContent = "preserved higher-priority content"
    let recovering = false
    const getHigherItem = vi.fn(async (key: string) => ({ key, content: higherContent }))
    const getLowerItem = vi.fn(async (key: string) => {
      if (recovering && key === "missing.md" && replacement === "foreign owner") {
        await writeFile("shared.md", { path: "shared.md", content: "lower-priority content", metadata: { source: "other" } })
      }
      return { key, content: "lower-priority content" }
    })
    const definition = {
      name: "startup-snapshot-precedence",
      sources: {
        higher: custom({ materialize: "startup", mount: "", async getKeys() { return ["shared.md"] }, getItem: getHigherItem }),
        lower: custom({ materialize: "startup", mount: "", async getKeys() { return ["shared.md", "missing.md"] }, getItem: getLowerItem }),
      },
    }
    await createWorkspaceSourceView(definition, store).list("")
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: higherContent })
    expect(getHigherItem).toHaveBeenCalledTimes(1)
    higherContent = "new provider content"
    await store.rm("missing.md")
    recovering = true
    if (replacement.startsWith("concurrent")) {
      const compareAndSwapFile = store.compareAndSwapFile!.bind(store)
      store.compareAndSwapFile = async (path, expected, file) => {
        if (path === "shared.md") {
          await writeFile(path, {
            ...expected,
            ...(replacement === "concurrent content" ? { content: "concurrent user content" } : {}),
            ...(replacement === "concurrent metadata" ? { metadata: { ...expected.metadata, owner: "user" } } : {}),
            ...(replacement === "concurrent mediaType" ? { mediaType: "text/user" } : {}),
          })
        }
        await compareAndSwapFile(path, expected, file)
      }
    }

    const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
    await inspection.list("")

    await expect(store.readFile("missing.md")).resolves.toMatchObject({ content: "lower-priority content" })
    await expect(store.readFile("shared.md")).resolves.toMatchObject({
      content: replacement === "none" ? "preserved higher-priority content" : replacement === "concurrent content" ? "concurrent user content" : "lower-priority content",
      ...(replacement === "foreign owner" ? { metadata: { source: "other" } } : {}),
      ...(replacement === "concurrent metadata" ? { metadata: { owner: "user" } } : {}),
      ...(replacement === "concurrent mediaType" ? { mediaType: "text/user" } : {}),
    })
    expect(getHigherItem).toHaveBeenCalledTimes(1)
    expect(getLowerItem).toHaveBeenCalledTimes(4)
  })

  it("preserves a file replacing an ancestor of a nested startup mount", async () => {
    const store = createMemoryWorkspaceStore()
    const getItem = vi.fn(async (key: string) => ({ key, content: "generated" }))
    const definition = {
      name: "replaced-startup-ancestor",
      sources: {
        generated: custom({ materialize: "startup", mount: "docs/nested", async getKeys() { return ["file.md"] }, getItem }),
      },
    }
    await createWorkspaceSourceView(definition, store).list("")
    await store.rm("docs", { recursive: true })
    await store.writeFile("docs", { path: "docs", content: "user" })
    expect(await store.stat("docs/nested")).toBeUndefined()

    const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
    await inspection.list("")

    await expect(store.readFile("docs")).resolves.toMatchObject({ content: "user" })
    await expect(store.stat("docs/nested")).resolves.toBeUndefined()
    expect(getItem).toHaveBeenCalledTimes(1)
  })
})
