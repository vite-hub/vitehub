import { describe, expect, it } from "vitest"

import { fetch, file, github, glob, markdown, mcpResources } from "../src/index.ts"
import { normalizeWorkspaceSource } from "../src/sources/config.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

import type { WorkspaceSource, WorkspaceSourceInput } from "../src/core/types.ts"

const runtimeOptions = {
  cache: { maxAge: 60 },
  materialize: "startup",
  mount: "inherited",
  sync: true,
  validate: "request",
} as const

const client = {
  async listResources() { return { resources: [] } },
  async readResource() { return { contents: [] } },
}

const factories = [
  { name: "file", create: (options: object) => file(options as never), input: { content: "docs", workspacePath: "README.md" }, mount: "", materialize: undefined },
  { name: "markdown", create: (options: object) => markdown(options as never), input: { content: "docs", workspacePath: "README.md" }, mount: undefined, materialize: undefined },
  { name: "glob", create: (options: object) => glob(options as never), input: { include: "**/*.md" }, mount: undefined, materialize: undefined },
  { name: "github", create: (options: object) => github(options as never), input: { auth: false, repo: "acme/docs" }, mount: undefined, materialize: undefined },
  { name: "mcpResources", create: (options: object) => mcpResources(options as never), input: { server: client }, mount: undefined, materialize: "lazy" },
]

describe("Workspace Source runtime options", () => {
  it.each(factories)("ignores inherited runtime options in $name()", ({ create, input, mount, materialize }) => {
    const source = create(Object.assign(Object.create(runtimeOptions), input))

    expect(source).toMatchObject({
      cache: undefined,
      materialize,
      mount,
      sync: undefined,
      validate: undefined,
    })
  })

  it.each(factories)("preserves own runtime options in $name()", ({ create, input }) => {
    expect(create({ ...input, ...runtimeOptions })).toMatchObject(runtimeOptions)
  })

  it.each(factories)("does not run inherited runtime getters in $name()", ({ create, input }) => {
    const prototype = Object.fromEntries(Object.keys(runtimeOptions).map(key => [key, undefined]))
    for (const key of Object.keys(runtimeOptions)) {
      Object.defineProperty(prototype, key, { get() { throw new Error(`Inherited ${key} getter ran`) } })
    }
    expect(() => create(Object.assign(Object.create(prototype), input))).not.toThrow()
  })

  it.each(["direct", "inferred", "binding"])("ignores inherited runtime options on a %s Source", kind => {
    const methods: WorkspaceSource = {
      async getKeys() { return ["README.md"] },
      async getItem(key) { return { content: "docs", key } },
    }
    const input = Object.assign(Object.create(runtimeOptions), kind === "direct" ? methods : kind === "binding" ? { source: methods } : { content: "docs", workspacePath: "README.md" }) as WorkspaceSourceInput
    expect(normalizeWorkspaceSource("docs", input)).toMatchObject({
      cache: false,
      materialize: "build",
      mountPath: kind === "inferred" ? "" : "docs",
      sync: false,
      validate: false,
    })
  })

  it("materializes an inline file when sync is inherited", async () => {
    const store = createMemoryWorkspaceStore()
    const options = Object.assign(Object.create({ sync: true }), { content: "docs", workspacePath: "README.md" })
    await syncWorkspaceDefinition({ name: "inherited-sync", sources: { docs: options } }, store)
    expect(await store.readFile("README.md")).toMatchObject({ content: "docs" })
  })

  it("ignores inherited mount settings and sync policy fields", () => {
    const source: WorkspaceSource = {
      async getKeys() { return [] },
      async getItem(key) { return { content: "", key } },
      mount: Object.create({ cache: { maxAge: 60 }, materialize: "startup", path: "inherited", validate: "request" }),
      sync: Object.create({ concurrency: "skip", stale: "remove" }),
    }
    expect(normalizeWorkspaceSource("docs", source)).toMatchObject({
      cache: false,
      materialize: "none",
      mountPath: "docs",
      sync: { concurrency: undefined, stale: "keep" },
      validate: false,
    })
  })

  it("keeps explicit false options and own bindings with null prototypes", () => {
    const source = file({ content: "docs", workspacePath: "README.md", ...runtimeOptions })
    const binding = Object.assign(Object.create(null), { source, cache: false, materialize: "build", mount: "", sync: false, validate: false }) as WorkspaceSourceInput
    expect(normalizeWorkspaceSource("docs", binding)).toMatchObject({ cache: false, materialize: "build", mountPath: "", sync: false, validate: false })
  })

  it("ignores inherited runtime options in direct fetch()", () => {
    const options = Object.assign(Object.create({ materialize: "startup", sync: true }), {
      url: "https://status.example.com/health",
    })
    expect(fetch(options as never)).toMatchObject({ materialize: "lazy", sync: undefined })
  })

  it("ignores inherited cache fields", () => {
    const cache = Object.assign(Object.create({ maxAge: 60 }), {})
    const source: WorkspaceSource = {
      async getKeys() { return [] },
      async getItem(key) { return { content: "", key } },
      cache,
    }
    expect(normalizeWorkspaceSource("docs", source).cache).toEqual({})
  })

  it("preserves non-runtime fetch options outside enumerable own properties", () => {
    const prototype = { url: "https://status.example.com/health" }
    const options = Object.create(prototype)
    Object.defineProperty(options, "workspacePath", { value: "health.json", enumerable: false })
    expect(fetch(options as never)).toMatchObject({ materialize: "lazy" })
  })

  it("keeps the original receiver for fetch option getters", () => {
    let reads = 0
    const options = {
      url: "https://status.example.com/health",
      workspacePath: "health.json",
      get transform(): (data: unknown) => unknown {
        reads++
        return (data: unknown) => this.url.endsWith("/health") ? data : "wrong"
      },
    }
    const source = fetch(options)
    expect(reads).toBe(0)
    expect(source).toMatchObject({ materialize: "lazy" })
    expect(reads).toBe(0)
  })
})
