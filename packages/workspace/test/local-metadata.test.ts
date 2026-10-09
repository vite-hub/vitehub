import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"

import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workspace-local-metadata-"))
  roots.push(directory)
  const root = join(directory, "workspace")
  const metadataPath = `${root}.meta.json`
  await writeFile(metadataPath, JSON.stringify({ ready: "persisted" }))
  return { root, metadataPath, store: createLocalWorkspaceStore(root) }
}

it("loads persisted metadata for concurrent first reads and writes", async () => {
  const { root, store } = await fixture()
  await expect(Promise.all([
    store.getMeta!("ready"),
    store.getMeta!("ready"),
    store.setMeta!("new", "saved"),
  ])).resolves.toEqual(["persisted", "persisted", undefined])
  const reopened = createLocalWorkspaceStore(root)
  await expect(reopened.getMeta!("ready")).resolves.toBe("persisted")
  await expect(reopened.getMeta!("new")).resolves.toBe("saved")
})

it("retries metadata reads after a damaged sidecar is repaired", async () => {
  const { metadataPath, store } = await fixture()
  await writeFile(metadataPath, "invalid JSON")
  await expect(store.getMeta!("ready")).rejects.toThrow()
  await writeFile(metadataPath, JSON.stringify({ ready: "repaired" }))
  await expect(store.getMeta!("ready")).resolves.toBe("repaired")
})

it("preserves unrelated metadata and observes updates across Store instances", async () => {
  const { root, store: first } = await fixture()
  const second = createLocalWorkspaceStore(root)
  await first.setMeta!("first", 1)
  await second.setMeta!("second", 2)
  await first.setMeta!("third", 3)
  await expect(first.getMeta!("second")).resolves.toBe(2)
  await expect(second.getMeta!("third")).resolves.toBe(3)
  const reopened = createLocalWorkspaceStore(root)
  await expect(reopened.getMeta!("ready")).resolves.toBe("persisted")
  await expect(reopened.getMeta!("second")).resolves.toBe(2)
})

it.each([1, 3])("serializes concurrent metadata writes from %i Store instances", async (count) => {
  const { root, metadataPath } = await fixture()
  const stores = Array.from({ length: count }, () => createLocalWorkspaceStore(root))
  const values = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`key-${index}`, index]))
  await Promise.all(Object.entries(values).map(([key, value], index) => stores[index % count]!.setMeta!(key, value)))
  expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({ ready: "persisted", ...values })
})

it("keeps rejected writes out of metadata and permits a later write", async () => {
  const { store } = await fixture()
  await expect(store.setMeta!("ready", 1n)).rejects.toThrow()
  await expect(store.getMeta!("ready")).resolves.toBe("persisted")
  await store.setMeta!("ready", "updated")
  await expect(store.getMeta!("ready")).resolves.toBe("updated")
})

it("isolates nested metadata reads from the cache and later writes", async () => {
  const { root, metadataPath, store } = await fixture()
  const persisted = { nested: { label: "persisted" }, items: [{ count: 1 }] }
  await store.setMeta!("object", persisted)
  await store.setMeta!("array", persisted.items)

  const first = await store.getMeta!("object") as typeof persisted
  first.nested.label = "changed"
  first.items[0]!.count = 2
  const second = await store.getMeta!("object") as typeof persisted
  expect(second).toEqual(persisted)
  second.items.push({ count: 3 })

  const array = await store.getMeta!("array") as typeof persisted.items
  array[0]!.count = 4
  array.push({ count: 5 })
  await expect(store.getMeta!("array")).resolves.toEqual(persisted.items)
  await expect(store.getMeta!("missing")).resolves.toBeUndefined()

  await store.setMeta!("unrelated", "saved")
  expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({
    ready: "persisted", object: persisted, array: persisted.items, unrelated: "saved",
  })
  const reopened = createLocalWorkspaceStore(root)
  await expect(reopened.getMeta!("object")).resolves.toEqual(persisted)
  await expect(reopened.getMeta!("array")).resolves.toEqual(persisted.items)
})
