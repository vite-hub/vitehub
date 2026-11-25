import { installOperationRegistryLoader } from "@vite-hub/internal/operation-registry"

export default function viteHubConsoleOperationLoader(): void {
  installOperationRegistryLoader(async () => {
    await import("#vitehub/console/app")
    const { loadConsoleRuntime } = await import("./server/runtime.ts")
    await loadConsoleRuntime()
  })
}
