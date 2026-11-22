# @vite-hub/shell decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Shell: sh-syntax WASM loading, timeout before abort, invocation budget, preflight scope

`loadParser`, `bundledWasmModule`, `withDriverTimeout`, `preflightUnsupportedWorkspaceCommand`, `exec` in `packages/shell/src/command/sh-syntax.ts`, `packages/shell/src/command/wasm-module.d.ts`, `packages/shell/src/providers/just-bash.ts`, `packages/shell/src/workspace/inspection.ts`, `packages/shell/src/runtime/session.ts`.

**Context:** Hosts deliver ?module imports differently; drivers reject on abort; session caps; Just Bash checks nested commands.

**Decision:** Accept a Module or bytes; settle timeout before abort; charge every attempt; preflight only top-level commands.

**Consequences:** One loader for all hosts; timeouts always report as timeouts; no budget bypass; relies on Just Bash's nested check.

## Comments that end in a backslash mark the command invalid

`stripLineContinuations` (`commentContinuation`) in `packages/shell/src/command/parse.ts`.

**Context:** Bash ends a comment at the newline, even when the comment ends in `\`. sh-syntax (un-ts/sh-syntax, which wraps mvdan/sh) joins the next line to the comment, so the parsed commands differ from what Bash runs. A policy check on those commands would miss the next line.

**Decision:** When a comment outside quotes ends in a backslash and a newline, the command is reported as one invalid segment.

**Consequences:** Such commands are rejected instead of analysed. Remove the check when sh-syntax ends a comment at the newline the way Bash does; that needs an upstream report to un-ts/sh-syntax (or mvdan/sh if the cause is in the parser).

## sh-syntax WebAssembly types are declared by hand

`declare const WebAssembly` in `packages/shell/src/command/sh-syntax.ts`.

**Context:** The repository's TypeScript config has no DOM lib, and `@types/node` 24 does not declare the `WebAssembly` global. The shell package uses three members of it.

**Decision:** Declare only `Module`, `compile`, and `instantiate`, with the types the loader needs.

**Consequences:** Remove the declaration when `@types/node` declares `WebAssembly`, or when the package typechecks with a lib that includes it.

## A failed `sh-syntax/main.wasm?module` import means the Node parser

`bundledWasmModule` in `packages/shell/src/command/sh-syntax.ts`.

**Context:** The Cloudflare Worker builds for Vite and Nuxt still use the `?module` import to load the parser's WASM explicitly rather than depend on the bundler selecting the `workerd` export added in sh-syntax 0.8.4. Plain Node cannot resolve `?module`; there, sh-syntax reads `main.wasm` from its own package through `parse`.

**Decision:** Only a failed import falls back to sh-syntax's `parse`. When `parse` is missing too, `SHELL_SH_SYNTAX_WASM_UNAVAILABLE` carries the import error as `cause`. A failed `WebAssembly.compile` throws.

**Consequences:** Remove the `?module` import when every host can load sh-syntax through its own export conditions.
