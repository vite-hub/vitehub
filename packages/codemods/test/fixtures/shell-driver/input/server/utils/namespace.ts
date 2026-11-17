import * as justBash from "@vite-hub/shell/providers/just-bash"
import * as shell from "@vite-hub/shell"

export const runtime = shell.createShellRuntime({
  provider: justBash.createJustBashProvider({ fs: memoryFs() }),
})

export type Driver = shell.ShellExecutionProvider

declare function memoryFs(): justBash.JustBashFileSystem
