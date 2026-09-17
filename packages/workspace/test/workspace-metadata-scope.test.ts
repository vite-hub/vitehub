import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import type { WorkspaceDefinition } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { removedStartupFileMatches } from "../src/sources/materialization.ts"
import { captureStartupDirectoryRemoval, removedStartupDirectoryMatches, removedStartupDirectoryMetaKey } from "../src/sources/startup-directory-evidence.ts"
import { createWorkspaceSourceView, invalidateWorkspaceSourceMaterialization } from "../src/sources/view.ts"

// Current definitions require a name, but persisted unnamed Workspace metadata
// remains supported. Exercise that legacy runtime input without widening the API.
function workspaceFixture<S extends NonNullable<WorkspaceDefinition["sources"]>>(name: string | undefined, sources: S) {
  return { name, sources } as WorkspaceDefinition & { sources: S }
}

const scopes = [undefined, "default", "null", ""]
const pairs = scopes.flatMap(owner => scopes.filter(observer => observer !== owner).map(observer => ({ owner, observer })))

it.each(pairs)("retains startup cleanup ownership for $owner after inspecting $observer", async ({ owner, observer }) => {
  const store = createMemoryWorkspaceStore()
  const sources = { generated: custom({ materialize: "startup", files: [{ path: "nested/file.md", content: "generated" }] }) }
  await createWorkspaceSourceView(workspaceFixture(owner, sources), store).materializeSources()

  await createWorkspaceSourceView(workspaceFixture(observer, {}), store).materializeSources()
  await expect(store.readFile("generated/nested/file.md")).resolves.toMatchObject({ content: "generated" })
  await syncWorkspaceDefinition(workspaceFixture(owner, {}), store)

  await expect(store.stat("generated/nested/file.md")).resolves.toBeUndefined()
  await expect(removedStartupFileMatches(store, owner, "generated/nested/file.md", "generated")).resolves.toBe(true)
  await expect(removedStartupFileMatches(store, observer, "generated/nested/file.md", "generated")).resolves.toBe(false)
})

it.each(pairs)("keeps promoted Skills owned by $owner after inspecting $observer", async ({ owner, observer }) => {
  const store = createMemoryWorkspaceStore()
  const destination = ".agents/skills/review/SKILL.md"
  const source = (content: string) => custom({ materialize: "startup", files: [{ path: destination, content }] })
  const definition = workspaceFixture(owner, { generated: source("# Original") })
  await createWorkspaceSourceView(definition, store).materializeSources()

  await createWorkspaceSourceView(workspaceFixture(observer, {}), store).materializeSources()
  await expect(store.readFile(destination)).resolves.toMatchObject({ content: "# Original" })
  definition.sources.generated = source("# Updated")
  await invalidateWorkspaceSourceMaterialization(definition, store, ["generated"])
  await createWorkspaceSourceView(definition, store).materializeSources()
  await expect(store.readFile(destination)).resolves.toMatchObject({ content: "# Updated" })

  await createWorkspaceSourceView(workspaceFixture(owner, {}), store).materializeSources()
  await expect(store.readFile(destination)).resolves.toBeUndefined()
})

it.each(pairs)("does not share directory-removal evidence between $owner and $observer", async ({ owner, observer }) => {
  const store = createMemoryWorkspaceStore()
  const path = "generated/nested"
  const baseline = "snapshot"
  await store.setMeta!(removedStartupDirectoryMetaKey(owner, path), await captureStartupDirectoryRemoval(store, path, baseline))

  await expect(removedStartupDirectoryMatches(store, owner, path, baseline)).resolves.toBe(true)
  await expect(removedStartupDirectoryMatches(store, observer, path, baseline)).resolves.toBe(false)
})

it.each(["refresh", "remove", "user-edit", "legacy"])("round-trips startup metadata through JSON during %s", async (action) => {
  const store = createMemoryWorkspaceStore()
  const metadata = new Map<string, string>()
  store.setMeta = async (key, value) => { metadata.set(key, String(JSON.stringify(value))) }
  store.getMeta = async (key) => {
    const value = metadata.get(key)
    return value === undefined ? undefined : JSON.parse(value)
  }
  if (action === "legacy") metadata.set("workspace:startup-sources", "[]")
  const definition = workspaceFixture(action === "legacy" ? undefined : "json-metadata", {
    generated: custom({ materialize: "startup", files: [{ path: "file.md", content: "generated" }] }),
  })
  await createWorkspaceSourceView(definition, store).materializeSources()
  await expect(removedStartupFileMatches(store, definition.name, "generated/file.md", "generated")).resolves.toBe(false)

  if (action === "refresh") {
    definition.sources.generated = custom({ materialize: "startup", files: [] })
    await invalidateWorkspaceSourceMaterialization(definition, store, ["generated"])
    await createWorkspaceSourceView(definition, store).materializeSources()
  }
  else {
    if (action === "user-edit") await store.writeFile("generated/file.md", { path: "generated/file.md", content: "user edit" })
    await syncWorkspaceDefinition(workspaceFixture(definition.name, {}), store)
  }
  await expect(removedStartupFileMatches(store, definition.name, "generated/file.md", "generated")).resolves.toBe(action !== "user-edit")
  if (action === "user-edit") await expect(store.readFile("generated/file.md")).resolves.toMatchObject({ content: "user edit" })
  for (const value of metadata.values()) expect(() => JSON.parse(value)).not.toThrow()
})
