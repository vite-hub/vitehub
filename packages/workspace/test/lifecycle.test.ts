import { afterEach, describe, expect, it, vi } from "vitest"

import { installHostedWorkspaceRuntime } from "../src/hosted.ts"
import { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "../src/runtime/state.ts"
import { createWorkspaceStore } from "../src/lifecycle.ts"

afterEach(() => {
  setWorkspaceHostedStoreLoader(undefined)
  vi.unstubAllGlobals()
})

describe("workspace lifecycle", () => {
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
