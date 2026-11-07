/**
 * Test mode for app tests. `vite-hub/test` turns it on, and each Server Primitive then uses a local backend that lives
 * until the next reset, instead of its configured driver. The state is on `globalThis`, so every package copy in the
 * process sees the same test mode. This module imports nothing, so every host bundle can include it;
 * `./test-mode-setup.ts` creates the mode with Node APIs.
 */
export interface ViteHubTestMode {
  /** Server Env values that the test set. Server Env reads them before `process.env`. */
  readonly env: Record<string, string>
  /** The app folder that has `server/`. Database reads its migrations from there. */
  readonly root: string
  /**
   * Returns the backend with this key, and creates it on the first call after a reset. `dispose` runs on the next
   * reset. A Primitive keeps no backend of its own in test mode, so a reset gives every test empty storage.
   */
  backend: <T>(key: string, create: () => T, dispose?: (value: Awaited<T>) => unknown) => T
  /** Returns the backend with this key when the current test created it. */
  peek: <T>(key: string) => T | undefined
  /** Returns an empty folder for this key under `<root>/.vitehub/test`. The next reset deletes it. */
  directory: (key: string) => Promise<string>
  /** Disposes every backend, deletes the temporary folders, and clears the Server Env values. */
  reset: () => Promise<void>
}

/** The `globalThis` key of the active test mode. */
export const viteHubTestModeKey: unique symbol = Symbol.for("vitehub.test")

export type ViteHubTestModeGlobal = typeof globalThis & { [viteHubTestModeKey]?: ViteHubTestMode }

/** The active test mode, or `undefined` outside tests. */
export function getViteHubTestMode(): ViteHubTestMode | undefined {
  return (globalThis as ViteHubTestModeGlobal)[viteHubTestModeKey]
}
