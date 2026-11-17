import * as justBash from "@vite-hub/shell/providers/just-bash"
import * as shell from "@vite-hub/shell"

export const runtime = shell.createShellRuntime({
  driver: justBash.createJustBashDriver({ fs: memoryFs() }),
})

export type Driver = shell.ShellDriver

declare function memoryFs(): justBash.JustBashFileSystem
