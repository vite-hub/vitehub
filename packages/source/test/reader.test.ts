import { afterEach, describe, expect, it, vi } from "vitest"

import { clearSources, createSource, defineSource, registerSource, useSource } from "../src/index.ts"
import { file } from "../src/file.ts"
import type { SourceContext } from "../src/index.ts"

afterEach(clearSources)

describe("direct Source readers", () => {
  it("reads a file definition without registration", async () => {
    const reader = createSource(file({ workspacePath: "guide/start.md", content: "# Start" }))

    await expect(reader.keys()).resolves.toEqual(["guide/start.md"])
    await expect(reader.read("guide/start.md")).resolves.toBe("# Start")
    await expect(reader.read("guide/start.md", { encoding: "binary" })).resolves.toEqual(new TextEncoder().encode("# Start"))
    await expect(reader.list()).resolves.toEqual([{ key: "guide", type: "directory" }])
    await expect(reader.list("guide")).resolves.toEqual([{ key: "guide/start.md", type: "file" }])
  })

  it("uses typed records and bulk loading directly", async () => {
    const getItem = vi.fn(async (key: "article_1") => ({ key, data: { title: "One" } }))
    const getItems = vi.fn(async () => [{ key: "article_1" as const, data: { title: "One" } }])
    const reader = createSource(defineSource({
      name: "articles",
      async getKeys() { return ["article_1"] },
      getItem,
      getItems,
      async getMeta() { return { revision: "1" } },
    }))

    await expect(reader.items()).resolves.toEqual([{ key: "article_1", data: { title: "One" } }])
    expect(getItems).toHaveBeenCalledOnce()
    expect(getItem).not.toHaveBeenCalled()
    await expect(reader.get("article_1")).resolves.toEqual({ key: "article_1", data: { title: "One" } })
    await expect(reader.meta("article_1")).resolves.toEqual({ revision: "1" })
  })

  it("pins one revision for concurrent operations and refreshes with another reader", async () => {
    let originRevision = 1
    const prepare = vi.fn(async (context: SourceContext) => {
      expect(context.revision?.id).toBeDefined()
    })
    const resolveRevision = vi.fn(async () => ({ id: String(originRevision), immutable: true }))
    const source = defineSource({
      name: "docs",
      resolveRevision,
      prepare,
      async getKeys() { return ["index.md"] },
      async getItem(key: string, context: SourceContext) {
        return { key, content: `Revision ${context.revision?.id}` }
      },
    })
    const reader = createSource(source)
    await expect(Promise.all([reader.keys(), reader.read("index.md"), reader.items()])).resolves.toEqual([
      ["index.md"], "Revision 1", [{ key: "index.md", content: "Revision 1" }],
    ])
    expect(resolveRevision).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()

    originRevision = 2
    await expect(reader.read("index.md")).resolves.toBe("Revision 1")
    await expect(createSource(source).read("index.md")).resolves.toBe("Revision 2")
    expect(resolveRevision).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it.each(["revision", "prepare"] as const)("keeps a failed %s attempt local to its reader", async stage => {
    const failure = new Error(stage)
    let fail = true
    const attempt = vi.fn(async () => { if (fail) throw failure })
    const getItem = vi.fn(async (key: string) => ({ key, content: "ready" }))
    const source = defineSource({
      name: "docs",
      async resolveRevision() {
        if (stage === "revision") await attempt()
        return { id: "1", immutable: true }
      },
      async prepare() { if (stage === "prepare") await attempt() },
      async getKeys() { return ["index.md"] },
      getItem,
    })
    const reader = createSource(source)
    await expect(reader.read("index.md")).rejects.toBe(failure)
    fail = false
    await expect(reader.read("index.md")).rejects.toBe(failure)
    expect(attempt).toHaveBeenCalledOnce()
    expect(getItem).not.toHaveBeenCalled()
    await expect(createSource(source).read("index.md")).resolves.toBe("ready")
  })

  it("keeps reader contexts and cancellation separate when definitions are reused", async () => {
    const canceled = new AbortController()
    const active = new AbortController()
    const contexts: SourceContext[] = []
    const source = defineSource({
      name: "docs",
      async getKeys(context: SourceContext) {
        contexts.push(context)
        context.abortSignal?.throwIfAborted()
        return ["index.md"]
      },
      async getItem(key: string) { return { key, content: "ready" } },
    })
    const first = createSource(source, { rootDir: "/first", abortSignal: canceled.signal })
    const second = createSource(source, { rootDir: "/second", abortSignal: active.signal })
    canceled.abort()

    await expect(first.keys()).rejects.toMatchObject({ name: "AbortError" })
    await expect(second.keys()).resolves.toEqual(["index.md"])
    expect(contexts.map(context => context.rootDir)).toEqual(["/first", "/second"])
    expect(contexts[0]).not.toBe(contexts[1])
    expect(contexts[1]?.abortSignal).toBe(active.signal)
  })

  it("uses the same lifecycle for registered definitions without mutating caller context", async () => {
    const contexts: SourceContext[] = []
    const source = defineSource({
      name: "provider",
      async prepare(context: SourceContext) { contexts.push(context) },
      async getKeys() { return ["README.md"] },
      async getItem(key: string, context: SourceContext) { return { key, content: context.revision?.id ?? "" } },
    })
    registerSource("readme", source)
    const context = { rootDir: "/docs", revision: { id: "pinned", immutable: true } }
    await expect(createSource(source, context).read("README.md")).resolves.toBe("pinned")
    await expect(useSource("readme", context).read("README.md")).resolves.toBe("pinned")
    expect(contexts.map(value => value.source)).toEqual(["provider", "readme"])
    expect(contexts.every(value => value !== context)).toBe(true)
    expect(context).toEqual({ rootDir: "/docs", revision: { id: "pinned", immutable: true } })
  })
})
