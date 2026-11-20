import type { ViteDevServer } from "vite"
import type { ModuleRunner } from "vite/module-runner"

/** The module runner that `importViteDevModule()` made for a Vite dev environment, and the function that closes it. */
export const devModuleRunners = new WeakMap<object, { close: () => Promise<void>, runner: ModuleRunner }>()

/**
 * Closes the module runners of a dev server. A runner patches `Error.prepareStackTrace`, and Vite keeps the runner's
 * modules in a process-wide set until it closes. This module imports no runtime code, so the dev server can call it
 * when it closes.
 */
export async function closeViteDevModuleRunners(server: Pick<ViteDevServer, "environments">): Promise<void> {
  await Promise.all(Object.values(server.environments).map(async (environment) => {
    const entry = devModuleRunners.get(environment)
    devModuleRunners.delete(environment)
    await entry?.close()
  }))
}
