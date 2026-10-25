import { describe, expect, it, vi } from "vitest"

import { createSource, defineSource, splitSource } from "../src/index.ts"
import { file } from "../src/file.ts"

import type { SourceContext } from "../src/index.ts"

const docs = defineSource({
  name: "docs",
  async getKeys() {
    return ["bars.md", "empty.md"]
  },
  async getItem(key: string) {
    return {
      key,
      path: `docs/${key}`,
      content: key === "bars.md" ? "## Bars\none\n## Lines\ntwo" : "no sections",
    }
  },
})

function sections(content: string) {
  return content.split(/^## /m).slice(1).map((part) => {
    const [title = "", ...body] = part.split("\n")
    return { key: title.toLowerCase(), data: { title, body: body.join("\n").trim() } }
  })
}

describe("splitSource()", () => {
  it("keeps split parts and metadata checks within each reader's revision", async () => {
    let revision = "old"
    const source = defineSource({
      name: "revisions",
      async resolveRevision() { return { id: revision, immutable: true } },
      async getKeys() { return ["entry"] },
      async getItem(key: string, ctx: SourceContext) {
        return { key, content: ctx.revision!.id }
      },
      async getMeta(_key: string, ctx: SourceContext) {
        return { revision: ctx.revision!.id }
      },
    })
    const split = vi.fn((item: { content: string }) => [{ key: item.content, content: item.content }])
    const definition = splitSource({ source, split })
    const oldReader = createSource(definition)
    await expect(oldReader.keys()).resolves.toEqual(["entry#old"])

    revision = "new"
    const newReader = createSource(definition)
    await expect(newReader.meta("entry#new")).resolves.toEqual({ revision: "new" })
    await expect(newReader.items()).resolves.toEqual([{ key: "entry#new", content: "new" }])
    await expect(newReader.get("entry#new")).resolves.toEqual({ key: "entry#new", content: "new" })
    await expect(oldReader.get("entry#old")).resolves.toEqual({ key: "entry#old", content: "old" })
    await expect(oldReader.meta("entry#new")).rejects.toThrow("could not find")
    expect(split).toHaveBeenCalledTimes(2)
  })

  it("does not reuse a failed split when opening another reader", async () => {
    const split = vi.fn<() => Promise<{ key: string, content: string }[]>>()
      .mockRejectedValueOnce(new Error("split failed"))
      .mockResolvedValue([{ key: "part", content: "recovered" }])
    const definition = splitSource({ source: docs, split })

    await expect(createSource(definition).get("bars.md#part")).rejects.toThrow("split failed")
    await expect(createSource(definition).get("bars.md#part")).resolves.toMatchObject({ content: "recovered" })
    expect(split).toHaveBeenCalledTimes(2)
  })

  it("lists one item per part, keyed by the parent key and the part key", async () => {
    const reader = createSource(splitSource({
      source: docs,
      split: item => sections(String(item.content)),
    }))

    await expect(reader.keys()).resolves.toEqual(["bars.md#bars", "bars.md#lines"])
    await expect(reader.items()).resolves.toEqual([
      { key: "bars.md#bars", path: "docs/bars.md", data: { title: "Bars", body: "one" } },
      { key: "bars.md#lines", path: "docs/bars.md", data: { title: "Lines", body: "two" } },
    ])
    await expect(reader.get("bars.md#lines")).resolves.toEqual({
      key: "bars.md#lines",
      path: "docs/bars.md",
      data: { title: "Lines", body: "two" },
    })
  })

  it("reads only the parent item for one part", async () => {
    const getItem = vi.fn(docs.getItem)
    const reader = createSource(splitSource({
      source: { ...docs, getItem },
      split: item => sections(String(item.content)),
    }))

    await reader.get("bars.md#bars")
    expect(getItem).toHaveBeenCalledOnce()
    expect(getItem.mock.calls[0]?.[0]).toBe("bars.md")
  })

  it("preserves parent metadata and delegates composite metadata lookups", async () => {
    const getMeta = vi.fn(async () => ({ digest: "parent", shared: "parent" }))
    const source = defineSource({
      name: "metadata",
      async getKeys() { return ["entry"] },
      async getItem(key: string) {
        return { key, metadata: { shared: "parent", inherited: true } }
      },
      getMeta,
    })
    const reader = createSource(splitSource({
      source,
      split: () => [{ key: "part", metadata: { shared: "part" } }],
    }))

    await expect(reader.items()).resolves.toEqual([{
      key: "entry#part",
      metadata: { shared: "part", inherited: true },
    }])
    await expect(reader.meta("entry#part")).resolves.toEqual({ digest: "parent", shared: "parent" })
    expect(getMeta).toHaveBeenCalledWith("entry", expect.any(Object))
    await expect(reader.meta("entry#missing")).rejects.toThrow("could not find \"entry#missing\"")
    expect(getMeta).toHaveBeenCalledOnce()
  })

  it("does not split parent content for an uncached metadata lookup", async () => {
    const split = vi.fn(() => [{ key: "part" }])
    const getMeta = vi.fn(async () => ({ digest: "parent" }))
    const reader = createSource(splitSource({
      source: defineSource({
        name: "metadata-only",
        async getKeys() { return ["entry"] },
        async getItem(key: string) { return { key, content: "content" } },
        getMeta,
      }),
      split,
    }))

    await expect(reader.meta("entry#part")).resolves.toEqual({ digest: "parent" })
    expect(split).not.toHaveBeenCalled()
    expect(getMeta).toHaveBeenCalledWith("entry", expect.any(Object))
  })

  it("keeps file methods when every part has content", async () => {
    const reader = createSource(splitSource({
      source: file({ workspacePath: "guide.md", content: "## Start\nHi\n## End\nBye" }),
      split: item => sections(String(item.content)).map(part => ({ key: part.key, content: part.data.body })),
    }))

    await expect(reader.keys()).resolves.toEqual(["guide.md#start", "guide.md#end"])
    await expect(reader.read("guide.md#end")).resolves.toBe("Bye")
  })

  it("rejects part keys that are empty, contain #, or repeat", async () => {
    const reader = (keys: string[]) => createSource(splitSource({
      source: docs,
      split: item => item.key === "bars.md" ? keys.map(key => ({ key })) : [],
    }))

    await expect(reader([""]).items()).rejects.toThrow("must be a non-empty string without \"#\"")
    await expect(reader(["a#b"]).items()).rejects.toThrow("must be a non-empty string without \"#\"")
    await expect(reader(["a", "a"]).items()).rejects.toThrow("returned the part key \"a\" twice")
  })

  it("names a missing part", async () => {
    const reader = createSource(splitSource({ source: docs, split: () => [] }))

    await expect(reader.get("bars.md#area")).rejects.toThrow("could not find \"bars.md#area\"")
  })
})
