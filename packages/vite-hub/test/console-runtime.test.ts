import * as v from "valibot"
import { afterEach, expect, it, vi } from "vitest"
import { defineOperation, installedOperationRegistry, installOperationRegistryLoader } from "@vite-hub/internal/operations"

import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { consoleOperationRegistry, installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleRuntime, loadConsoleRuntime } from "../src/console/runtime/server/runtime.ts"
import { requestEvent } from "./console-event.ts"

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.runtime"))
  installOperationRegistryLoader(undefined)
  installConsoleOperations([])
  installConsoleAccess({ mode: "open" })
})

it.each(["before", "after"])("keeps the replacement when an older load finishes %s it", async (order) => {
  let releaseOld = () => {}
  let releaseNew = () => {}
  const oldReady = new Promise<void>((resolve) => { releaseOld = resolve })
  const newReady = new Promise<void>((resolve) => { releaseNew = resolve })
  const operation = (name: string) => defineOperation({
    description: "Identify a runtime installation.",
    input: v.strictObject({}),
    kind: "read",
    name,
    run: () => name,
    section: "fixture",
  })
  const installOld = vi.fn(() => { installConsoleOperations([{ operations: [operation("fixture.old")] }]) })
  const oldLoad = vi.fn(async () => {
    await oldReady
    return installOld
  })
  const newLoad = vi.fn(async () => {
    await newReady
    return () => { installConsoleOperations([{ operations: [operation("fixture.new")] }]) }
  })
  const readConsole = withConsoleAccess(() => consoleOperationRegistry(), { anySection: true })
  const event = () => (requestEvent(new Request("http://localhost/_vitehub/console")))
  installConsoleAccess({ mode: "open" })
  try {
    installConsoleRuntime(oldLoad)
    const oldRead = installedOperationRegistry()
    installConsoleRuntime(newLoad)
    const newRead = installedOperationRegistry()
    if (order === "before") {
      releaseOld()
      await oldLoad.mock.results[0]?.value
    }
    releaseNew()
    const replacementRegistry = await newRead
    expect(replacementRegistry?.get("fixture.new")).toBeDefined()
    expect(await readConsole(event())).toBe(replacementRegistry)

    releaseOld()
    expect(await oldRead).toBe(replacementRegistry)
    expect(await installedOperationRegistry()).toBe(replacementRegistry)
    expect(await readConsole(event())).toBe(replacementRegistry)
    expect(oldLoad).toHaveBeenCalledOnce()
    expect(newLoad).toHaveBeenCalledOnce()
    expect(installOld).not.toHaveBeenCalled()
  }
  finally {
    releaseOld()
    releaseNew()
  }
})

it.each(["import", "install"])("retries a failed %s and shares the successful load", async (failure) => {
  const install = vi.fn<() => void>()
  const load = vi.fn<() => Promise<() => void>>().mockResolvedValue(install)
  if (failure === "import") load.mockRejectedValueOnce(new Error("rebuilding"))
  else install.mockImplementationOnce(() => { throw new Error("rebuilding") })
  installConsoleRuntime(load)

  await expect(loadConsoleRuntime()).rejects.toThrow("rebuilding")
  await Promise.all([loadConsoleRuntime(), loadConsoleRuntime()])
  await loadConsoleRuntime()
  expect(load).toHaveBeenCalledTimes(2)
  expect(install).toHaveBeenCalledTimes(failure === "import" ? 1 : 2)
})
