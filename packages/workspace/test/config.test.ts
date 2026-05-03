import { describe, expect, it } from "vitest"

import { normalizeWorkspaceOptions, resolveRuntimeVercelBlobWorkspaceStore } from "../src/config.ts"

describe("workspace config", () => {
  it("defaults to Cloudflare Artifacts on Cloudflare hosting", () => {
    const config = normalizeWorkspaceOptions({}, {
      env: {
        VITEHUB_WORKSPACE_ARTIFACTS_NAMESPACE: "e2e",
        VITEHUB_WORKSPACE_ARTIFACTS_REPO_PREFIX: "workspace-",
      },
      hosting: "cloudflare_module",
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual(expect.objectContaining({
      binding: "WORKSPACE_ARTIFACTS",
      branch: "main",
      namespace: "e2e",
      provider: "cloudflare-artifacts",
      repoPrefix: "workspace-",
    }))
  })

  it("defaults to memory on Vercel hosting", () => {
    const config = normalizeWorkspaceOptions({}, {
      env: {
        VITEHUB_WORKSPACE_BLOB_PREFIX: "workspace/e2e",
      },
      hosting: "vercel",
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual({
      provider: "memory",
    })
  })

  it("defaults to Vercel Blob when a Blob token is available", () => {
    const config = normalizeWorkspaceOptions({}, {
      env: {
        BLOB_READ_WRITE_TOKEN: "runtime-token",
        VITEHUB_WORKSPACE_BLOB_PREFIX: "workspace/e2e",
      },
      hosting: "vercel",
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual({
      access: "private",
      prefix: "workspace/e2e",
      provider: "vercel-blob",
      token: "********",
    })
  })

  it("defaults to local storage without a hosting signal", () => {
    const config = normalizeWorkspaceOptions({}, {
      env: {},
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual({
      provider: "local",
    })
  })

  it("preserves explicit memory stores", () => {
    const config = normalizeWorkspaceOptions({
      store: {
        provider: "memory",
      },
    }, {
      env: {
        BLOB_READ_WRITE_TOKEN: "runtime-token",
      },
      hosting: "cloudflare_module",
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual({
      provider: "memory",
    })
  })

  it("masks explicit Vercel Blob tokens in resolved config", () => {
    const config = normalizeWorkspaceOptions({
      store: {
        provider: "vercel-blob",
        token: "secret-token",
      },
    }, {
      rootDir: "/repo",
    })

    expect(JSON.stringify(config)).not.toContain("secret-token")
    expect(config && config.store).toMatchObject({
      provider: "vercel-blob",
      token: "********",
    })
  })

  it("rehydrates masked Vercel Blob tokens at runtime", () => {
    expect(resolveRuntimeVercelBlobWorkspaceStore({
      provider: "vercel-blob",
      token: "********",
    }, {
      BLOB_READ_WRITE_TOKEN: "runtime-token",
    })).toMatchObject({
      token: "runtime-token",
    })
  })
})
