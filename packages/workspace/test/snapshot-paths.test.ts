import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../src/storage/utils.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe.each(["memory", "local"] as const)("%s Workspace snapshot paths", (provider) => {
  it.each(["__proto__", "constructor", "toString"])("preserves %s through added, modified, and removed diffs", async (path) => {
    const root = provider === "local" ? await mkdtemp(join(tmpdir(), "vitehub-snapshot-paths-")) : undefined
    if (root) tempDirs.push(root)
    const store = root ? createLocalWorkspaceStore(join(root, "files")) : createMemoryWorkspaceStore()
    const empty = { ...await store.snapshot(), entries: {} }

    await store.writeFile(path, { path, content: "first" })
    expect((await store.diff({ from: empty })).entries.map(({ path, type }) => ({ path, type }))).toEqual([{ path, type: "added" }])
    const first = await store.snapshot()
    expect(Object.keys(first.entries)).toEqual([path])
    expect(Object.hasOwn(JSON.parse(JSON.stringify(first.entries)), path)).toBe(true)

    await store.writeFile(path, { path, content: "changed" })
    expect((await store.diff()).entries.map(({ path, type }) => ({ path, type }))).toEqual([{ path, type: "modified" }])

    await store.rm(path)
    expect((await store.diff()).entries.map(({ path, type }) => ({ path, type }))).toEqual([{ path, type: "removed" }])
  })
})

describe("shared Workspace snapshot paths", () => {
  it.each(["__proto__", "constructor", "toString"])("preserves %s and ignores inherited entries in caller snapshots", async (path) => {
    const empty = { id: "empty", createdAt: new Date(0).toISOString(), entries: {} }
    const snapshot = await createSnapshotFromEntries([{ path, type: "file", digest: "first", size: 5 }])
    expect(Object.keys(snapshot.entries)).toEqual([path])
    expect(diffSnapshots(empty, snapshot).entries.map(({ path, type }) => ({ path, type }))).toEqual([{ path, type: "added" }])
    expect(diffSnapshots(snapshot, empty).entries.map(({ path, type }) => ({ path, type }))).toEqual([{ path, type: "removed" }])
  })
})
