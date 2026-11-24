import { expect, it, vi } from "vitest"

import { installedOperationRegistry, installOperationRegistryLoader } from "@vite-hub/internal/operation-registry"

import { installConsoleRuntime } from "../src/console/runtime/server/runtime.ts"

it("installs the loader of the Console operations when an Agent imports the console capability", async () => {
  const install = vi.fn()
  installConsoleRuntime(async () => install)
  installOperationRegistryLoader(undefined)
  vi.resetModules()
  const { agentConsole } = await import("../src/console/runtime/server/agent-capability.ts")
  expect(agentConsole.resolve).toBeInstanceOf(Function)
  expect(install).not.toHaveBeenCalled()
  await installedOperationRegistry()
  expect(install).toHaveBeenCalledOnce()
})
