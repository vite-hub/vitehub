import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

it.each((["getMeta", "setMeta", "both"] as const).flatMap(missing => [false, true].map(fenced => ({ missing, fenced }))))("invalidates startup views after build output without $missing and fenced=$fenced", async ({ missing, fenced }) => {
  for (const reuseStartupSnapshots of [false, true]) {
    const store = createMemoryWorkspaceStore()
    if (missing !== "setMeta") store.getMeta = undefined
    if (missing !== "getMeta") store.setMeta = undefined
    const definition = {
      name: "volatile-startup-build",
      sources: {
        built: custom({ materialize: "build", mount: "", files: [{ path: "shared.md", content: "build" }] }),
        generated: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "startup" }] }),
      },
    }
    await createWorkspaceSourceView(definition, store).materializeSources()
    const view = createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots })
    await expect(view.readFile("shared.md")).resolves.toBe("startup")

    await syncWorkspaceDefinition(definition, store, fenced ? new AbortController().signal : undefined)
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "build" })
    await expect(view.readFile("shared.md")).resolves.toBe("startup")
  }
})
