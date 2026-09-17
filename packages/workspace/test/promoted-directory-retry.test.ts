import { afterEach, expect, it, vi } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"
import { markFileAttributesUnavailable } from "../src/internal/file-attributes.ts"

afterEach(resetWorkspaceRegistry)

it.each(["SKILL.md", "checks.md"])("retains promoted directory ownership after %s fails and the Workspace restarts", async (failedFile) => {
  const store = createMemoryWorkspaceStore()
  const baseline = await store.snapshot()
  const root = ".agents/skills/review"
  const definition = defineWorkspace({ store, sources: {
    portal: custom({ materialize: "startup", files: [
      { path: `${root}/SKILL.md`, content: "# Review" },
      { path: `${root}/checks.md`, content: "# Checks" },
    ] }),
  } })
  registerWorkspace("promotion-retry", definition)
  const workspace = await useRegisteredWorkspace("promotion-retry")
  const writeFileConditional = store.writeFileConditional!.bind(store)
  const write = vi.spyOn(store, "writeFileConditional").mockImplementation(async (path, file, digest) => {
    if (path === `${root}/${failedFile}`) throw new Error("promotion write failed")
    return writeFileConditional(path, file, digest)
  })
  await expect(workspace.materializeSources?.()).rejects.toThrow("promotion write failed")
  expect((await store.stat(root))?.type).toBe("directory")
  expect(await store.readFile(`${root}/SKILL.md`)).toBeUndefined()
  write.mockRestore()
  resetWorkspaceRegistry()
  registerWorkspace("promotion-retry", definition)
  const restarted = await useRegisteredWorkspace("promotion-retry")
  await restarted.materializeSources?.()
  expect((await restarted.diff()).entries).toEqual([])
  expect((await restarted.diff({ from: baseline })).entries).toContainEqual(expect.objectContaining({ path: root, type: "added" }))
})

it("does not adopt a user directory recreated after a failed promotion", async () => {
  const store = createMemoryWorkspaceStore()
  await store.snapshot()
  const root = ".agents/skills/review"
  registerWorkspace("promotion-user-retry", defineWorkspace({ store, sources: {
    portal: custom({ materialize: "startup", files: [{ path: `${root}/SKILL.md`, content: "# Review" }] }),
  } }))
  const workspace = await useRegisteredWorkspace("promotion-user-retry")
  const writeFileConditional = store.writeFileConditional!.bind(store)
  const write = vi.spyOn(store, "writeFileConditional").mockImplementation(async (path, file, digest) => {
    if (path === `${root}/SKILL.md`) throw new Error("promotion write failed")
    return writeFileConditional(path, file, digest)
  })
  await expect(workspace.materializeSources?.()).rejects.toThrow("promotion write failed")
  await store.rm(".agents", { recursive: true })
  await store.mkdir(root, { recursive: true })
  write.mockRestore()
  await workspace.materializeSources?.()
  expect((await workspace.diff()).entries.map(entry => entry.path)).toEqual([".agents", ".agents/skills", root])
})

it.each([false, true].flatMap(cas => [false, true].map(edited => ({ cas, edited }))))("recovers promoted file ownership after registry publication fails with CAS=$cas, edited=$edited", async ({ cas, edited }) => {
  const store = createMemoryWorkspaceStore()
  if (!cas) store.compareAndSwapFile = undefined
  await store.snapshot()
  const path = ".agents/skills/review/SKILL.md"
  const definition = defineWorkspace({ store, sources: {
    portal: custom({ materialize: "startup", files: [{ path, content: "# Review" }] }),
  } })
  registerWorkspace("promotion-registry-retry", definition)
  const workspace = await useRegisteredWorkspace("promotion-registry-retry")
  const setMeta = store.setMeta!.bind(store)
  const checkpoint = vi.spyOn(store, "setMeta").mockImplementation(async (key, value) => {
    if (key.startsWith("workspace:promoted-source-skills:") && !key.startsWith("workspace:promoted-source-skills:pending:")) throw new Error("promotion checkpoint failed")
    return setMeta(key, value)
  })
  await expect(workspace.materializeSources?.()).rejects.toThrow("promotion checkpoint failed")
  expect((await store.readFile(path))?.content).toBe("# Review")
  if (edited) {
    const file = (await store.readFile(path))!
    await store.writeFile(path, { ...file, metadata: { owner: "user" } })
  }
  checkpoint.mockRestore()
  resetWorkspaceRegistry()
  registerWorkspace("promotion-registry-retry", definition)
  const restarted = await useRegisteredWorkspace("promotion-registry-retry")
  await restarted.materializeSources?.()
  if (edited) {
    expect((await store.readFile(path))?.metadata).toEqual({ owner: "user" })
    expect((await restarted.diff()).entries).toContainEqual(expect.objectContaining({ path, type: "added" }))
  }
  else expect((await restarted.diff()).entries).toEqual([])
})

it.each([false, true])("recovers promotion canceled after writing the file with CAS=%s", async (cas) => {
  const store = createMemoryWorkspaceStore()
  if (!cas) store.compareAndSwapFile = undefined
  await store.snapshot()
  const path = ".agents/skills/review/SKILL.md"
  registerWorkspace("promotion-cancel-retry", defineWorkspace({ store, sources: {
    portal: custom({ materialize: "startup", files: [{ path, content: "# Review" }] }),
  } }))
  const workspace = await useRegisteredWorkspace("promotion-cancel-retry")
  const abort = new AbortController()
  const writeFileConditional = store.writeFileConditional!.bind(store)
  const write = vi.spyOn(store, "writeFileConditional").mockImplementation(async (destination, file, digest) => {
    const result = await writeFileConditional(destination, file, digest)
    if (destination === path) abort.abort(new Error("promotion canceled"))
    return result
  })
  await expect(workspace.materializeSources?.({ abortSignal: abort.signal })).rejects.toThrow("promotion canceled")
  write.mockRestore()
  await workspace.materializeSources?.()
  expect((await workspace.diff()).entries).toEqual([])
})

it("does not recover pending promotion ownership from matching bytes without the write attempt", async () => {
  const store = createMemoryWorkspaceStore()
  await store.snapshot()
  const path = ".agents/skills/review/SKILL.md"
  registerWorkspace("promotion-unknown-attempt", defineWorkspace({ store, sources: {
    portal: custom({ materialize: "startup", files: [{ path, content: "# Review" }] }),
  } }))
  const workspace = await useRegisteredWorkspace("promotion-unknown-attempt")
  const conditionalWrite = store.writeFileConditional!.bind(store)
  const write = vi.spyOn(store, "writeFileConditional").mockImplementation(async (destination, file, digest) => {
    if (destination === path) {
      await store.writeFile(path, { path, content: "# Review" })
      throw new Error("promotion write failed")
    }
    return conditionalWrite(destination, file, digest)
  })
  await expect(workspace.materializeSources?.()).rejects.toThrow("promotion write failed")
  write.mockRestore()
  const readFile = store.readFile.bind(store)
  const read = vi.spyOn(store, "readFile").mockImplementation(async (destination) => {
    const file = await readFile(destination)
    return destination === path && file ? markFileAttributesUnavailable(file) : file
  })
  await workspace.materializeSources?.()
  expect((await store.readFile(path))?.metadata).toBeUndefined()
  expect((await workspace.diff()).entries).toContainEqual(expect.objectContaining({ path, type: "added" }))
  read.mockRestore()
})
