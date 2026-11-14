import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: SHELL_R0005 and SHELL_R0006.
export const shellErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/shell/diagnostics",
  codes: {
    SHELL_R0001: { ...dynamicError, fix: "Pass a positive `timeoutMs` to `analyzeShellCommand()` or `session.analyze()`, or remove it to use the 100 ms default." },
    SHELL_R0002: { ...dynamicError, fix: "Shorten the command, or raise `timeoutMs` of `analyzeShellCommand()` or `session.analyze()`. The default is 100 ms." },
    SHELL_R0003: { ...dynamicError, fix: "Correct the shell syntax of the command at the place that the message names. For example, close each quote, bracket, and `if` block." },
    SHELL_R0004: { ...dynamicError, fix: "Write the `curl` command with one valid URL and only `-s`, `-S`, `-L`, `-X` with `GET`, `HEAD`, or `POST`, `--url`, `--json` with valid JSON, or `-d`. Do not pass headers or cookies, because the Source grant adds the credentials." },
    SHELL_R0007: { ...dynamicError, fix: "Pass exactly one URL to `curl`. Run one `curl` command for each URL." },
    SHELL_R0008: { ...dynamicError, fix: "Create a new Shell session to start the process. Do not call `startProcess()` after `dispose()`." },
    SHELL_R0009: { ...dynamicError, fix: "Use a Shell provider that supports background processes, or run the command with `exec()`." },
    SHELL_R0010: { ...dynamicError, fix: "Stop a background process before you start another, or raise `policy.maxProcesses` in `createShellRuntime()`." },
    SHELL_R0011: { ...dynamicError, fix: "Do not dispose the Shell session while `startProcess()` runs. The other error in the `AggregateError` says why the process did not stop; stop it with the provider if it still runs." },
    SHELL_R0012: { ...dynamicError, fix: "Do not dispose the Shell session while `startProcess()` runs. Create a new session to start the process." },
    SHELL_R0013: { ...dynamicError, fix: "Use a path inside `/workspace`. Remove the `..` segments that leave the Workspace." },
    SHELL_R0014: { ...dynamicError, fix: "Mount the Workspace with `createWritableWorkspaceFs()` to let commands write, or run only commands that read files." },
    SHELL_R0015: { ...dynamicError, fix: "Do not run `chmod` in the Workspace filesystem. It does not keep file modes." },
    SHELL_R0016: { ...dynamicError, fix: "Do not create symbolic links, such as with `ln -s`, in the Workspace filesystem. Copy the file instead." },
    SHELL_R0017: { ...dynamicError, fix: "Do not create hard links, such as with `ln`, in the Workspace filesystem. Copy the file instead." },
    SHELL_R0018: { ...dynamicError, fix: "Do not run `readlink` in the Workspace filesystem. It has no symbolic links." },
    SHELL_R0019: { ...dynamicError, fix: "Do not run commands that set file times in the Workspace filesystem. It does not keep them." },
    SHELL_R0020: { ...dynamicError, fix: "Pass a path below the Workspace root to `cleanWorkspaceMutationPath()`, not `/`, `.`, or `/workspace`." },
    SHELL_R0021: { ...dynamicError, fix: "Use a path inside the Workspace. Remove the `..` segments that leave `/workspace`." },
    SHELL_R0022: { ...dynamicError, fix: "Move the path to a place outside itself. A directory cannot move into one of its own subdirectories." },
    SHELL_R0023: { ...dynamicError, fix: "The Workspace root exists already. Pass `-p` to `mkdir`, or create a directory below the root." },
    SHELL_R0024: {
      ...dynamicError,
      fix: "Make the provider return its process handle within the Shell timeout, or raise the Shell policy timeout if longer startup is expected.",
    },
  },
})
