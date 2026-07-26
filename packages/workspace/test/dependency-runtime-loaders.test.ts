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

  it("directs consumers to install the missing shell runtime", async () => {
    const cause = Object.assign(new Error("Cannot find package '@vite-hub/shell' imported from /consumer/node_modules/@vite-hub/workspace/dist/dependency-loaders.js"), {
      code: "ERR_MODULE_NOT_FOUND",
    })
    setWorkspaceDependencyRuntimeLoaders({
      shellWorkspace: async () => {
        throw cause
      },
    })

    await expect(loadWorkspaceShellModule()).rejects.toMatchObject({
      cause,
      code: "WORKSPACE_FAILED",
      message: "[vitehub] Install @vite-hub/shell to use Workspace Tools shell commands.",
      name: "ViteHubError",
    })
  })

  it("recognizes a missing shell runtime under Yarn PnP", async () => {
    const cause = Object.assign(new Error("@vite-hub/workspace tried to access @vite-hub/shell, but it isn't declared in its dependencies; this makes the require call ambiguous and unsound."), {
      code: "MODULE_NOT_FOUND",
    })
    setWorkspaceDependencyRuntimeLoaders({
      shellWorkspace: async () => {
        throw cause
      },
    })

    await expect(loadWorkspaceShellModule()).rejects.toMatchObject({
      cause,
      code: "WORKSPACE_FAILED",
      message: "[vitehub] Install @vite-hub/shell to use Workspace Tools shell commands.",
    })
  })

  it("preserves shell runtime initialization failures", async () => {
    const cause = Object.assign(new Error("Cannot find module '@vite-hub/shell-plugin' required by /consumer/node_modules/@vite-hub/shell/dist/workspace.js"), {
      code: "ERR_MODULE_NOT_FOUND",
    })
    setWorkspaceDependencyRuntimeLoaders({
      shellWorkspace: async () => {
        throw cause
      },
    })

    await expect(loadWorkspaceShellModule()).rejects.toBe(cause)
  })
})
