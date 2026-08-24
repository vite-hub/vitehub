import { afterEach, describe, expect, it, vi } from "vitest"

import {
  clearSources,
  custom,
  defineSources,
  registerSource,
  registerSources,
  useSource,
} from "../src/index.ts"
import { sourcePathError } from "../src/core/errors.ts"
import { file } from "../src/file.ts"

afterEach(() => {
  clearSources()
})

describe("@vite-hub/source registry", () => {
  it("resolves one revision before preparing and reading a Source", async () => {
    const revisions: Array<string | undefined> = []
    let resolutionCount = 0
    registerSources({
      docs: {
        name: "docs",
        async resolveRevision() {
          resolutionCount++
          return { id: "revision-1", immutable: true, ref: "main" }
        },
        async prepare(ctx) {
          revisions.push(ctx.revision?.id)
        },
        async getKeys(ctx) {
          revisions.push(ctx.revision?.id)
          return ["README.md"]
        },
        async getItem(key, ctx) {
          revisions.push(ctx.revision?.id)
          return { content: "# Readme", key }
        },
      },
    })

    const docs = useSource("docs")
    await expect(docs.revision()).resolves.toEqual({ id: "revision-1", immutable: true, ref: "main" })
    await expect(docs.read("README.md")).resolves.toBe("# Readme")
    expect(resolutionCount).toBe(1)
    expect(revisions).toEqual(["revision-1", "revision-1"])
  })

  it("bounds invalid Source paths", () => {
    const error = sourcePathError(`../${"x".repeat(20_000)}`)
    expect(error).toMatchObject({ code: "SOURCE_PATH_INVALID" })
    expect(error.details?.path).toHaveLength(4_096)
  })

  it("registers sources and reads through useSource", async () => {
    registerSources(defineSources({
      docs: file({ content: "# Docs\n", workspacePath: "README.md" }),
      custom: custom({
        name: "custom",
        async getKeys() {
          return ["data.json"]
        },
        async getItem(key) {
          return { key, data: { ok: true } }
        },
      }),
    }))

    const docs = useSource("docs")

    await expect(docs.keys()).resolves.toEqual(["README.md"])
    await expect(docs.read("README.md")).resolves.toBe("# Docs\n")
    await expect(docs.get("README.md")).resolves.toMatchObject({ mediaType: "text/markdown" })
    await expect(docs.exists("README.md")).resolves.toBe(true)
    await expect(docs.exists("missing.md" as any)).resolves.toBe(false)
    await expect(docs.list()).resolves.toEqual([{ key: "README.md", type: "file" }])
    await expect(docs.items()).resolves.toMatchObject([{ key: "README.md" }])
    await expect(useSource("custom").get("data.json")).resolves.toMatchObject({ data: { ok: true } })
  })

  it("uses a source bulk reader when available", async () => {
    const getItem = vi.fn()
    const getItems = vi.fn(async () => [
      { data: { title: "One" }, key: "one" },
      { data: { title: "Two" }, key: "two" },
    ])

    registerSource("articles", custom({
      name: "articles",
      async getKeys() {
        return ["one", "two"]
      },
      getItem,
      getItems,
    }))

    await expect(useSource("articles").items()).resolves.toHaveLength(2)
    expect(getItems).toHaveBeenCalledOnce()
    expect(getItem).not.toHaveBeenCalled()
  })

  it("throws a source-specific error for missing registrations", () => {
    expect(() => useSource("missing" as any)).toThrow(expect.objectContaining({ code: "SOURCE_NOT_FOUND", name: "ViteHubError" }))
  })

  it("passes the abort signal to custom Source methods", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined

    registerSources({
      custom: custom({
        name: "custom",
        async getKeys(ctx) {
          receivedSignal = ctx.abortSignal
          return []
        },
        async getItem(key) {
          return { key }
        },
      }),
    })

    await useSource("custom", { abortSignal: controller.signal }).keys()

    expect(receivedSignal).toBe(controller.signal)
  })
})
