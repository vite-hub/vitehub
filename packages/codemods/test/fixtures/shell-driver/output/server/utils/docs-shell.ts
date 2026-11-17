import { createShellRuntime } from "vite-hub/shell"
import { createJustBashDriver } from "vite-hub/shell/providers/just-bash"
import { createReadonlyWorkspaceFs } from "vite-hub/shell/workspace"
import { useWorkspace } from "vite-hub/workspace"

import type { ShellDriver } from "vite-hub/shell"
import type { JustBashDriverOptions } from "vite-hub/shell/providers/just-bash"

export function docsShell(options: Omit<JustBashDriverOptions, "fs"> = {}) {
  const provider: ShellDriver = createJustBashDriver({
    ...options,
    commands: ["ls", "cat", "rg"],
    fs: createReadonlyWorkspaceFs(useWorkspace("docs").fs),
  })
  return createShellRuntime({ policy: { timeout: 10_000 }, driver: provider })
}

export function inlineShell() {
  return createShellRuntime({
    driver: createJustBashDriver({ fs: createReadonlyWorkspaceFs(useWorkspace("docs").fs) }),
  })
}

export function sharedShell(options: Parameters<typeof createShellRuntime>[0]) {
  return createShellRuntime(options)
}
