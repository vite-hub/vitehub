import { createShellRuntime } from "@vite-hub/shell"

export async function lazyShell(fs: import("@vite-hub/shell/providers/just-bash").JustBashFileSystem) {
  const { createJustBashProvider } = await import("@vite-hub/shell/providers/just-bash")
  return createShellRuntime({ provider: createJustBashProvider({ fs }) })
}

export { createJustBashProvider as justBash } from "@vite-hub/shell/providers/just-bash"
