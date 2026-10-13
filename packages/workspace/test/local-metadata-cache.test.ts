import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  readFile.mockImplementation(actual.readFile)
  return { ...actual, default: { ...actual, readFile }, readFile }
})

const { createLocalWorkspaceStore } = await import("../src/storage/local.ts")

it("does not reparse unchanged Workspace metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-metadata-cache-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await store.setMeta!("key", "value")
    readFile.mockClear()
    await expect(store.getMeta!("key")).resolves.toBe("value")
    readFile.mockClear()
    await expect(store.getMeta!("key")).resolves.toBe("value")
    expect(readFile).toHaveBeenCalledTimes(0)
    await store.setMeta!("next", "value")
    await expect(store.getMeta!("next")).resolves.toBe("value")
    expect(readFile).toHaveBeenCalledTimes(1)
  }
  finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.meta.json`, { force: true })
  }
})
