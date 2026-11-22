# @vite-hub/shell decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Shell: sh-syntax WASM loading, timeout before abort, invocation budget, preflight scope

`loadParser`, `bundledWasmModule`, `withDriverTimeout`, `preflightUnsupportedWorkspaceCommand`, `exec` in `packages/shell/src/command/sh-syntax.ts`, `packages/shell/src/command/wasm-module.d.ts`, `packages/shell/src/providers/just-bash.ts`, `packages/shell/src/workspace/inspection.ts`, `packages/shell/src/runtime/session.ts`.

**Context:** Hosts deliver ?module imports differently; drivers reject on abort; session caps; Just Bash checks nested commands.

**Decision:** Accept a Module or bytes; settle timeout before abort; charge every attempt; preflight only top-level commands.

**Consequences:** One loader for all hosts; timeouts always report as timeouts; no budget bypass; relies on Just Bash's nested check.
