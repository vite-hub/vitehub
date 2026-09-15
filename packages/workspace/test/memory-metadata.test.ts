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

describe("Memory Store conditional removal", () => {
  it.each([
    ["docs", "docs", true],
    ["other", "docs", false],
    [undefined, "docs", false],
    [undefined, null, true],
    ["docs", null, false],
  ] as const)("checks source %s against %s", async (source, ifSource, removed) => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("doc.md", { path: "doc.md", content: "user content", metadata: source ? { source } : undefined })
    await store.rm("doc.md", { ifSource })
    expect(await store.readFile("doc.md")).toEqual(removed ? undefined : expect.objectContaining({ content: "user content" }))
  })

  it("requires both digest and source conditions to match", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("doc.md", { path: "doc.md", content: "content", metadata: { source: "docs" } })
    const digest = (await store.stat("doc.md"))!.digest!
    await store.rm("doc.md", { ifDigest: digest, ifSource: "other" })
    expect(await store.readFile("doc.md")).toBeDefined()
    await store.rm("doc.md", { ifDigest: "stale", ifSource: "docs" })
    expect(await store.readFile("doc.md")).toBeDefined()
    await store.rm("doc.md", { ifDigest: digest, ifSource: "docs" })
    expect(await store.readFile("doc.md")).toBeUndefined()
  })

  it("leaves directories and missing paths unchanged under source conditions", async () => {
    const store = createMemoryWorkspaceStore()
    await store.mkdir("docs")
    await store.rm("docs", { recursive: true, ifSource: null })
    expect((await store.stat("docs"))?.type).toBe("directory")
    await expect(store.rm("missing", { ifSource: "docs" })).resolves.toBeUndefined()
  })
})
