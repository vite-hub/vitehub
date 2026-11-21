import { createShellRuntime } from "@vite-hub/shell"

export async function lazyShell(fs: import("@vite-hub/shell/providers/just-bash").JustBashFileSystem) {
  const { createJustBashDriver } = await import("@vite-hub/shell/providers/just-bash")
  return createShellRuntime({ driver: createJustBashDriver({ fs }) })
}

export { createJustBashDriver as justBash } from "@vite-hub/shell/providers/just-bash"
