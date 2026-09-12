import { describe, expect, it } from "vitest"

import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe("Memory Store metadata isolation", () => {
  it.each([false, true])("detaches metadata on writes (conditional: %s)", async (conditional) => {
    const store = createMemoryWorkspaceStore()
    const metadata = { source: "docs", nested: { tags: ["original"] } }
    const file = { path: "doc.md", content: "content", metadata }
    if (conditional) await store.writeFileConditional!(file.path, file, null)
    else await store.writeFile(file.path, file)

    metadata.source = "other"
    metadata.nested.tags.push("changed")
    expect((await store.readFile(file.path))?.metadata).toEqual({ source: "docs", nested: { tags: ["original"] } })
  })

  it("detaches metadata returned by reads and traversals", async () => {
    const store = createMemoryWorkspaceStore()
    const metadata = { source: "docs", nested: { tags: ["original"] } }
    await store.writeFile("doc.md", { path: "doc.md", content: "content", metadata })
    const outputs = [
      (await store.readFile("doc.md"))?.metadata,
      (await store.stat("doc.md"))?.metadata,
      (await store.list())[0]?.metadata,
      (await store.glob("*.md"))[0]?.metadata,
      (await store.snapshot()).entries["doc.md"]?.metadata,
    ]
    for (const output of outputs) {
      output!.source = 123
      output!.cycle = output
      ;(output!.nested as { tags: string[] }).tags.push("changed")
    }
    expect((await store.readFile("doc.md"))?.metadata).toEqual(metadata)
    expect((await store.stat("doc.md"))?.metadata).toEqual(metadata)
  })
})
