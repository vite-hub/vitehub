let installedKV: typeof import("@vite-hub/kv") | undefined

/**
 * Hands the KV module that Vite resolved to the Agent package. Node loads this package without Vite in `vite dev`,
 * so its own `@vite-hub/kv` import would miss the host's KV configuration. The `vite dev` Nitro plugin calls this.
 */
export function installAgentKV(module: typeof import("@vite-hub/kv") | undefined): void {
  installedKV = module
}

/** The Agent Vite plugin keeps this external when the host does not configure KV. */
export async function importOptionalKV(): Promise<typeof import("@vite-hub/kv")> {
  return installedKV ?? await import("@vite-hub/kv")
}
