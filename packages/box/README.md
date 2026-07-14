# @vite-hub/box

`@vite-hub/box` defines the execution environment used by a ViteHub harness Agent. `trustedHost()` runs against tools, configuration, and authentication already available on the host. `crabbox()` uses Crabbox Static SSH to run the harness through a provider-owned session.

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

`codexDriver()` contributes `codex` for ambient authentication and `codex-cli` for explicit authentication. At Box boot, `trustedHost()` runs `codex login status` for `codex`, checks only the executable for `codex-cli`, checks `gh auth status` for `github`, and verifies other requirement names on `PATH`.

Authentication values remain runtime-owned. A Box stores requirement names and an optional Home path, while its resolved environment is deliberately excluded from JSON serialization.

## Security boundary

A trusted-host Box provides no filesystem, credential, or process isolation. Use it only when the Agent is trusted to act as the host user. `@vite-hub/sandbox` remains the isolated execution primitive.

An explicit Box `cwd` cannot currently be combined with an Agent Workspace because Workspace materialization resets its target directory. Omit `cwd` when the Agent should use a disposable Workspace session.

## Crabbox

```ts
import { defineAgent } from "@vite-hub/agent"
import { codexDriver } from "@vite-hub/agent/harness/codex"
import { crabbox } from "@vite-hub/box/crabbox"

export default defineAgent<any, { worktreePath: string }>({
  box: {
    runtime: crabbox({ profile: "babysitter" }),
    cwd: ({ input }) => input.options?.worktreePath,
    requires: ["github", "pnpm"],
  },
  driver: codexDriver(),
})
```

Crabbox requires an explicit `cwd`. ViteHub treats that checkout as authoritative, creates a disposable harness cache inside the Crabbox session, and validates requirements inside the selected environment. Port access uses Crabbox tunnels by default; set `network: "direct"` only when the target shares the ViteHub process loopback network namespace.
