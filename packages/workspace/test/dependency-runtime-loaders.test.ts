import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getWorkspaceDependencyRuntimeLoaders,
  loadWorkspaceShellModule,
  setWorkspaceDependencyRuntimeLoaders,
} from "../src/runtime/dependency-loaders.ts"

afterEach(() => {
  setWorkspaceDependencyRuntimeLoaders(undefined)
})

describe("workspace dependency runtime loaders", () => {
  it("loads the shell integration by default", async () => {
    const shellWorkspace = await import("@vite-hub/shell/workspace")

    await expect(loadWorkspaceShellModule()).resolves.toHaveProperty("runWorkspaceInspectionCommand", shellWorkspace.runWorkspaceInspectionCommand)
  })

  it("shares the configured generated-host loader", async () => {
    const shellWorkspace = { runWorkspaceInspectionCommand: vi.fn() }
    const loaders = { shellWorkspace: vi.fn(async () => shellWorkspace) }

    setWorkspaceDependencyRuntimeLoaders(loaders)

    expect(getWorkspaceDependencyRuntimeLoaders()).toEqual(loaders)
    await expect(loadWorkspaceShellModule()).resolves.toBe(shellWorkspace)
  })
})
