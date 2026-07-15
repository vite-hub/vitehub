import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getWorkspaceDependencyRuntimeLoaders,
  loadWorkspaceSandboxModule,
  loadWorkspaceSandboxRuntimeStateModule,
  loadWorkspaceShellModule,
  setWorkspaceDependencyRuntimeLoaders,
} from "../src/runtime/dependency-loaders.ts"

afterEach(() => {
  setWorkspaceDependencyRuntimeLoaders(undefined)
})

describe("workspace dependency runtime loaders", () => {
  it("loads direct owner packages by default", async () => {
    const sandbox = await import("@vite-hub/sandbox")
    const sandboxRuntimeState = await import("@vite-hub/sandbox/runtime/state")
    const shellWorkspace = await import("@vite-hub/shell/workspace")

    await expect(loadWorkspaceSandboxModule()).resolves.toHaveProperty("createSandboxWithConfig", sandbox.createSandboxWithConfig)
    await expect(loadWorkspaceSandboxRuntimeStateModule()).resolves.toHaveProperty("getSandboxRuntimeConfig", sandboxRuntimeState.getSandboxRuntimeConfig)
    await expect(loadWorkspaceShellModule()).resolves.toHaveProperty("runWorkspaceInspectionCommand", shellWorkspace.runWorkspaceInspectionCommand)
  })

  it("shares configured generated-host loaders", async () => {
    const sandbox = { createSandboxWithConfig: vi.fn() }
    const sandboxRuntimeState = { getSandboxRuntimeConfig: vi.fn() }
    const shellWorkspace = { runWorkspaceInspectionCommand: vi.fn() }
    const loaders = {
      sandbox: vi.fn(async () => sandbox),
      sandboxRuntimeState: vi.fn(async () => sandboxRuntimeState),
      shellWorkspace: vi.fn(async () => shellWorkspace),
    }

    setWorkspaceDependencyRuntimeLoaders(loaders)

    expect(getWorkspaceDependencyRuntimeLoaders()).toEqual(loaders)
    await expect(loadWorkspaceSandboxModule()).resolves.toBe(sandbox)
    await expect(loadWorkspaceSandboxRuntimeStateModule()).resolves.toBe(sandboxRuntimeState)
    await expect(loadWorkspaceShellModule()).resolves.toBe(shellWorkspace)
  })

  it("keeps direct owner defaults for dependencies the framework does not override", () => {
    const defaults = getWorkspaceDependencyRuntimeLoaders()
    const shellWorkspace = vi.fn(async () => ({}))

    setWorkspaceDependencyRuntimeLoaders({ shellWorkspace })

    expect(getWorkspaceDependencyRuntimeLoaders()).toEqual({
      sandbox: defaults.sandbox,
      sandboxRuntimeState: defaults.sandboxRuntimeState,
      shellWorkspace,
    })
  })
})
