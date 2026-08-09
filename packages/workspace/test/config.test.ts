import { describe, expect, it } from "vitest"

import { normalizeWorkspaceOptions, normalizeWorkspaceStoreOptions, resolveRuntimeVercelBlobWorkspaceStore } from "../src/config.ts"
import { defineWorkspace } from "../src/core/define.ts"

describe("workspace config", () => {
  it("rejects unknown workspace definition options", () => {
    expect(() => defineWorkspace({
      stroe: { provider: "memory" },
    } as never)).toThrow("[vitehub] defineWorkspace does not support option: stroe.")
  })

  it("rejects unknown workspace module config options", () => {
    expect(() => normalizeWorkspaceOptions({
      stores: { provider: "memory" },
    } as never, {
      env: {},
      rootDir: "/repo",
    })).toThrow("[vitehub] workspace config does not support option: stores.")
  })

  it("leaves build assets enabled by default", () => {
    const config = normalizeWorkspaceOptions({}, {
      env: {},
      rootDir: "/repo",
    })

    expect(config && config.assets).toBeUndefined()
  })

  it("preserves explicit build asset selection", () => {
    const config = normalizeWorkspaceOptions({
      assets: ["docs"],
    }, {
      env: {},
      rootDir: "/repo",
    })

    expect(config && config.assets).toEqual(["docs"])
  })

  it("preserves disabled build assets", () => {
    const config = normalizeWorkspaceOptions({
      assets: false,
    }, {
      env: {},
      rootDir: "/repo",
    })

    expect(config && config.assets).toBe(false)
  })

  it("preserves explicit all-workspace build assets", () => {
    const config = normalizeWorkspaceOptions({
      assets: true,
    }, {
      env: {},
      rootDir: "/repo",
    })

    expect(config && config.assets).toBe(true)
  })

  it("defaults to memory without workspace options on Cloudflare hosting", () => {
    const config = normalizeWorkspaceOptions(undefined, {
      env: {},
      hosting: "cloudflare_module",
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual({
      provider: "memory",
    })
  })

  it("defaults to memory on Cloudflare hosting", () => {
    const config = normalizeWorkspaceOptions({}, {
      env: {
        VITEHUB_WORKSPACE_ARTIFACTS_NAMESPACE: "e2e",
        VITEHUB_WORKSPACE_ARTIFACTS_REPO_PREFIX: "workspace-",
      },
      hosting: "cloudflare_module",
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual({
      provider: "memory",
    })
  })

  it("preserves explicit Cloudflare Artifacts stores", () => {
    const config = normalizeWorkspaceOptions({
      store: {
        provider: "cloudflare-artifacts",
      },
    }, {
      env: {
        VITEHUB_WORKSPACE_ARTIFACTS_NAMESPACE: "e2e",
        VITEHUB_WORKSPACE_ARTIFACTS_REPO_PREFIX: "workspace-",
      },
      hosting: "cloudflare_module",
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual(expect.objectContaining({
      binding: "WORKSPACE_ARTIFACTS",
      namespace: "e2e",
      provider: "cloudflare-artifacts",
      repoPrefix: "workspace-",
    }))
    expect(config && config.store).not.toHaveProperty("branch")
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

  it("preserves explicit GitHub stores and masks tokens", () => {
    const config = normalizeWorkspaceOptions({
      store: {
        branch: "workspace-state",
        provider: "github",
        repository: "acme/app",
        root: ".vitehub/workspaces/<workspace>",
        token: "secret-token",
      },
    }, {
      rootDir: "/repo",
    })

    expect(JSON.stringify(config)).not.toContain("secret-token")
    expect(config && config.store).toEqual({
      branch: "workspace-state",
      provider: "github",
      repository: "acme/app",
      root: ".vitehub/workspaces/<workspace>",
      token: "********",
    })
  })

  it("preserves explicit GitHub tokens while resolving runtime definitions", () => {
    const store = normalizeWorkspaceStoreOptions({
      branch: "workspace-state",
      provider: "github",
      repository: "acme/app",
      root: ".vitehub/workspaces/<workspace>",
      token: "secret-token",
    }, {
      env: {},
      runtime: true,
    })

    expect(store).toEqual({
      branch: "workspace-state",
      provider: "github",
      repository: "acme/app",
      root: ".vitehub/workspaces/<workspace>",
      token: "secret-token",
    })
  })

  it("preserves lazy GitHub store options while resolving runtime definitions", () => {
    const branch = () => "workspace-state"
    const repository = () => "acme/app"
    const root = () => ".vitehub/workspaces/<workspace>"
    const token = () => "secret-token"
    const store = normalizeWorkspaceStoreOptions({
      branch,
      provider: "github",
      repository,
      root,
      token,
    }, {
      env: {},
      runtime: true,
    })

    expect(store).toEqual({
      branch,
      provider: "github",
      repository,
      root,
      token,
    })
  })

  it("defers absent GitHub runtime options until bindings are active", () => {
    const store = normalizeWorkspaceStoreOptions({
      provider: "github",
    }, {
      env: {},
      runtime: true,
    })

    expect(store).toEqual({
      branch: undefined,
      provider: "github",
      repository: undefined,
      root: undefined,
      token: "********",
    })
  })

  it("resolves GitHub store options from the environment", () => {
    const config = normalizeWorkspaceOptions({
      store: {
        provider: "github",
      },
    }, {
      env: {
        VITEHUB_WORKSPACE_GITHUB_BRANCH: "workspace-state",
        VITEHUB_WORKSPACE_GITHUB_REPOSITORY: "acme/app",
        VITEHUB_WORKSPACE_GITHUB_ROOT: "state/<workspace>",
      },
      rootDir: "/repo",
    })

    expect(config && config.store).toEqual({
      branch: "workspace-state",
      provider: "github",
      repository: "acme/app",
      root: "state/<workspace>",
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
