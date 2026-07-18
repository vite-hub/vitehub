import { afterEach, describe, expect, it } from "vitest"

import {
  clearSources,
  custom,
  defineSources,
  file,
  registerSources,
  SourceNotFoundError,
  useSource,
} from "../src/index.ts"

afterEach(() => {
  clearSources()
})

describe("@vite-hub/source registry", () => {
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
    await expect(useSource("custom").get("data.json")).resolves.toMatchObject({ data: { ok: true } })
  })

  it("throws a source-specific error for missing registrations", () => {
    expect(() => useSource("missing" as any)).toThrow(SourceNotFoundError)
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

  it("preserves errors thrown by custom Sources", async () => {
    const failure = new Error("custom source failure")
    registerSources({
      custom: custom({
        name: "custom",
        async getKeys() {
          throw failure
        },
        async getItem(key) {
          return { key }
        },
      }),
    })

    await expect(useSource("custom").keys()).rejects.toBe(failure)
  })
})
