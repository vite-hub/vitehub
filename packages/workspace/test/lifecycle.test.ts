import { afterEach, describe, expect, it, vi } from "vitest"

import { installHostedWorkspaceRuntime } from "../src/hosted.ts"
import { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "../src/runtime/state.ts"
import { createWorkspaceStore, syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  setWorkspaceHostedStoreLoader(undefined)
  vi.unstubAllGlobals()
})

describe("workspace lifecycle", () => {
  it("rejects compare-and-swap mutations from a loader after sync aborts", async () => {
    const store = createMemoryWorkspaceStore()
    const original = { path: "README.md", content: "original" }
    await store.writeFile(original.path, original)
    const controller = new AbortController()
    const started = deferred()
    const resume = deferred()
    const finished = deferred()
    const sync = syncWorkspaceDefinition({
      name: "docs",
      loaders: [{
        name: "late-mutation",
        async load(ctx) {
          started.resolve()
          await resume.promise
          try {
            await expect(async () => ctx.store.compareAndSwapFile!(original.path, original, undefined)).rejects.toBe(controller.signal.reason)
            finished.resolve()
          }
          catch (error) {
            finished.reject(error)
          }
        },
      }],
    }, store, controller.signal)
    await started.promise
    controller.abort(new Error("sync cancelled"))
    await expect(sync).rejects.toBe(controller.signal.reason)
    resume.resolve()
    await finished.promise
    await expect(store.readFile(original.path)).resolves.toMatchObject(original)
  })

  it("drains an active compare-and-swap before rejecting an aborted sync", async () => {
    const store = createMemoryWorkspaceStore()
    const original = { path: "README.md", content: "original" }
    await store.writeFile(original.path, original)
    const controller = new AbortController()
    const started = deferred()
    const resume = deferred()
    const compareAndSwap = store.compareAndSwapFile!.bind(store)
    vi.spyOn(store, "compareAndSwapFile").mockImplementation(async (...args) => {
      started.resolve()
      await resume.promise
      await compareAndSwap(...args)
    })
    const sync = syncWorkspaceDefinition({
      name: "docs",
      loaders: [{
        name: "active-mutation",
        async load(ctx) {
          await ctx.store.compareAndSwapFile!(original.path, original, undefined)
        },
      }],
    }, store, controller.signal)
    let settled = false
    const result = sync.catch(error => error).finally(() => { settled = true })
    await started.promise
    controller.abort(new Error("sync cancelled"))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    resume.resolve()
    await expect(result).resolves.toBe(controller.signal.reason)
    await expect(store.readFile(original.path)).resolves.toBeUndefined()
  })

  it("delegates hosted store creation through the runtime loader", async () => {
    setWorkspaceHostedStoreLoader((store, workspaceName) => ({
      async readFile() { return { path: workspaceName, content: store.provider } },
      async writeFile() {},
      async list() { return [] },
      async glob() { return [] },
      async stat() { return undefined },
      async mkdir() {},
      async rm() {},
      async snapshot() { return { id: "test", createdAt: new Date(0).toISOString(), entries: {} } },
      async diff() { return { to: "test", entries: [] } },
    }))

    try {
      const store = createWorkspaceStore({
        name: "docs",
        store: {
          provider: "vercel-blob",
          token: "********",
        },
      })

      await expect(store.readFile("README.md")).resolves.toMatchObject({ content: "vercel-blob" })
    }
    finally {
      setWorkspaceHostedStoreLoader(undefined)
    }
  })

  it("creates GitHub workspace stores without a hosted runtime loader", async () => {
    setWorkspaceHostedStoreLoader(undefined)
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/repos/acme/app/git/ref/heads/main") {
        return new Response(JSON.stringify({ object: { sha: "commit-sha" } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      }
      if (url.pathname === "/repos/acme/app/git/commits/commit-sha") {
        return new Response(JSON.stringify({ tree: { sha: "tree-sha" } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      }
      if (url.pathname === "/repos/acme/app/git/trees/tree-sha") {
        return new Response(JSON.stringify({ tree: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      }
      return new Response("not found", { status: 404 })
    }))

    const store = createWorkspaceStore({
      name: "docs",
      store: {
        provider: "github",
        repository: "acme/app",
        root: ".vitehub/workspaces/<workspace>",
        token: "github-token",
      },
    })

    await expect(store.list("", { recursive: true })).resolves.toEqual([])
  })

  it("preserves an existing hosted loader when installing the generic hosted runtime", async () => {
    setWorkspaceHostedStoreLoader((store, workspaceName) => ({
      async readFile() { return { path: workspaceName, content: `existing:${store.provider}` } },
      async writeFile() {},
      async list() { return [] },
      async glob() { return [] },
      async stat() { return undefined },
      async mkdir() {},
      async rm() {},
      async snapshot() { return { id: "test", createdAt: new Date(0).toISOString(), entries: {} } },
      async diff() { return { to: "test", entries: [] } },
    }))

    try {
      installHostedWorkspaceRuntime()
      const loader = getWorkspaceHostedStoreLoader()
      const store = loader?.({ provider: "vercel-blob", token: "********" }, "docs")

      await expect(store?.readFile("README.md")).resolves.toMatchObject({ content: "existing:vercel-blob" })
    }
    finally {
      setWorkspaceHostedStoreLoader(undefined)
    }
  })
})
