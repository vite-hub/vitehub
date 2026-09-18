import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { custom, type WorkspaceDefinition } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const cases = ["authority", "users"].flatMap(checkpoint => [false, true].map(reopen => ({ checkpoint, reopen })))

it.each(cases)("cleans shared build directories after a failed $checkpoint checkpoint, reopen=$reopen", async ({ checkpoint, reopen }) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-build-directory-checkpoint-"))
  const definition = (name: string): WorkspaceDefinition => ({ name, sources: {
    docs: custom({ materialize: "build", mount: "shared/nested", files: [{ path: `${name}.md`, content: name }] }),
  } })
  try {
    const store = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition(definition("first"), store)
    const setMeta = store.setMeta!.bind(store)
    store.setMeta = async (key, value) => {
      const authority = key === "workspace:second:build-directories" && Array.isArray(value) && value.includes("shared/nested")
      const users = key === "workspace:build-directory-users" && JSON.stringify(value).includes('"second"')
      if (checkpoint === "authority" ? authority : users) throw new Error("directory checkpoint unavailable")
      await setMeta(key, value)
    }
    await expect(syncWorkspaceDefinition(definition("second"), store)).rejects.toThrow("directory checkpoint unavailable")

    store.setMeta = setMeta
    const reopened = reopen ? createLocalWorkspaceStore(root) : store
    await syncWorkspaceDefinition({ name: "second", sources: {} }, reopened)
    await expect(reopened.readFile("shared/nested/first.md")).resolves.toMatchObject({ content: new TextEncoder().encode("first") })
    await syncWorkspaceDefinition({ name: "first", sources: {} }, reopened)
    await expect(reopened.stat("shared")).resolves.toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
