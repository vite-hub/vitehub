import { createShellRuntime } from "vite-hub/shell"
import { createJustBashProvider } from "vite-hub/shell/providers/just-bash"
import { createReadonlyWorkspaceFs } from "vite-hub/shell/workspace"
import { useWorkspace } from "vite-hub/workspace"

import type { ShellExecutionProvider } from "vite-hub/shell"
import type { JustBashProviderOptions } from "vite-hub/shell/providers/just-bash"

export function docsShell(options: Omit<JustBashProviderOptions, "fs"> = {}) {
  const provider: ShellExecutionProvider = createJustBashProvider({
    ...options,
    commands: ["ls", "cat", "rg"],
    fs: createReadonlyWorkspaceFs(useWorkspace("docs").fs),
  })
  return createShellRuntime({ policy: { timeout: 10_000 }, provider })
}

export function inlineShell() {
  return createShellRuntime({
    provider: createJustBashProvider({ fs: createReadonlyWorkspaceFs(useWorkspace("docs").fs) }),
  })
}

export function sharedShell(options: Parameters<typeof createShellRuntime>[0]) {
  return createShellRuntime(options)
}
