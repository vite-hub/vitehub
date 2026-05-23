import { describe, expect, it } from "vitest"

import { setWorkspaceHostedStoreLoader } from "../src/runtime/state.ts"
import { createWorkspaceStore } from "../src/lifecycle.ts"

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
})
