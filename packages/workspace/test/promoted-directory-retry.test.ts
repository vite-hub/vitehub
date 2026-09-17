import { afterEach, expect, it, vi } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

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
