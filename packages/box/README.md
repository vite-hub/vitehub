# @vite-hub/box

`@vite-hub/box` defines the execution environment used by a ViteHub harness Agent. The first runtime is `trustedHost()`, which runs against tools, configuration, and authentication already available on the host.

## Install

```sh
pnpm add @vite-hub/box
```

## Trusted host

Declare the Box inline with the Agent Definition:

```ts
import { defineAgent } from "@vite-hub/agent"
import { codexDriver } from "@vite-hub/agent/harness/codex"
import { trustedHost } from "@vite-hub/box"

export default defineAgent<any, { worktreePath: string }>({
  box: {
    runtime: trustedHost(),
    cwd: ({ input }) => input.options?.worktreePath,
    home: "/srv/vitehub/home",
    requires: ["github", "pnpm"],
  },
  driver: codexDriver(),
})
```

`cwd` is an authoritative mutable checkout. `home` points to a portable Home containing configuration such as `.codex`, `.config/gh`, and `.agents/skills`. When `home` is omitted, the Box inherits the host Home.

The Agent mounts the checkout into a disposable harness root. Project mutations remain in `cwd`, while harness bootstrap packages and resume data are removed with the session.

`codexDriver()` contributes the `codex` requirement automatically. At Box boot, `trustedHost()` checks `codex login status`, checks `gh auth status` for the `github` requirement, and verifies other requirement names on `PATH`.

Authentication values remain runtime-owned. A Box stores requirement names and an optional Home path, while its resolved environment is deliberately excluded from JSON serialization.

## Security boundary

A trusted-host Box provides no filesystem, credential, or process isolation. Use it only when the Agent is trusted to act as the host user. `@vite-hub/sandbox` remains the isolated execution primitive.

An explicit Box `cwd` cannot currently be combined with an Agent Workspace because Workspace materialization resets its target directory. Omit `cwd` when the Agent should use a disposable Workspace session.
