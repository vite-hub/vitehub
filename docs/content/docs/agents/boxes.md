---
title: Boxes
description: Run a harness Agent with an explicit workspace, Home, host tools, and named authentication requirements.
navigation.order: 22.5
icon: i-lucide-package-open
---

A Box is the execution environment for a harness Agent. It selects where the Agent runs, which Home it sees, and which host tools and authentication must be ready before the Agent starts.

Use `trustedHost()` when the Agent should run against the current host filesystem, processes, CLI installations, configuration, and authentication. Use `crabbox()` when the harness should run through Crabbox Static SSH while keeping the ViteHub Box contract.

## Run Codex in an existing checkout

Install the Agent and Box packages with the Codex harness adapter:

```bash [Terminal]
pnpm add @vite-hub/agent @vite-hub/box @ai-sdk/harness @ai-sdk/harness-codex
```

Declare the Box inline. You do not need a separate `defineBox()` call.

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from '@vite-hub/agent'
import { codexDriver } from '@vite-hub/agent/harness/codex'
import { trustedHost } from '@vite-hub/box'

interface BabysitterRunOptions {
  worktreePath: string
}

export default defineAgent<any, BabysitterRunOptions>({
  box: {
    runtime: trustedHost(),
    cwd: ({ input }) => input.options?.worktreePath,
    requires: ['github', 'pnpm'],
  },
  driver: codexDriver(),
})
```

The Box boots in `worktreePath`, preserves mutations in that checkout, and inherits the host Home. Codex therefore reads the repository's `AGENTS.md` and skills from the checkout while using the host's existing Codex configuration, selected model, authentication, and global skills. Harness bootstrap packages and resume data live in a disposable temporary root, so they do not dirty the authoritative checkout.

`codexDriver()` contributes its Codex requirement automatically. With ambient authentication it requires `codex login status`; with explicit driver authentication it checks only that the Codex CLI is installed. The Agent Definition only lists additional requirements used by its own workflow.

## Use a portable Home

Set `home` when the Agent should use a managed Home instead of the host user's current Home:

```ts
box: {
  runtime: trustedHost(),
  home: '/srv/vitehub/homes/babysitter',
}
```

The trusted-host runtime derives `HOME`, `XDG_CONFIG_HOME`, and `CODEX_HOME` from that directory. The directory can contain `.codex`, `.config/gh`, `.agents/skills`, `.gitconfig`, and other files consumed through normal Home and XDG conventions.

Keep the Home outside the project checkout and protect it as a credential bundle. The Box Definition stores only its path; authentication values remain in the runtime environment and are excluded from serialized Box metadata.

## Check requirements at boot

`trustedHost()` validates every requirement before harness execution:

| Requirement | Boot check |
| --- | --- |
| `codex` | Finds `codex` on `PATH` and runs `codex login status`. |
| `codex-cli` | Finds `codex` on `PATH` without requiring ambient authentication. |
| `github` | Finds `gh` on `PATH` and runs `gh auth status`. |
| Any other name | Finds an executable with that name on `PATH`. |

A failed check stops the Agent Invocation with the requirement name and command failure. This catches missing CLI installations and expired named authentication before Codex starts working.

## Keep the execution boundaries separate

| Primitive | Owns |
| --- | --- |
| Box | Harness execution environment, Home, working checkout, disposable cache, and boot requirements. |
| Workspace | File-tree context, Sources, rules, snapshots, and writeback. |
| Sandbox | Isolated provider execution for untrusted code. |

An explicit Box `cwd` is an authoritative checkout, so ViteHub does not combine it with Agent Workspace materialization in this first slice. Omit `cwd` when an Agent Workspace should be materialized into a disposable trusted-host session.

`trustedHost()` does not provide filesystem, credential, network, or process isolation. Use it only when the Agent is trusted to act with the host user's authority.

## Run through Crabbox

Crabbox is available from its provider-specific subpath:

```ts
import { crabbox } from '@vite-hub/box/crabbox'

box: {
  runtime: crabbox({ profile: 'babysitter' }),
  cwd: ({ input }) => input.options?.worktreePath,
  requires: ['github', 'pnpm'],
}
```

`crabbox()` requires `cwd`. The checkout remains authoritative, and each Agent Invocation gets a disposable harness cache linked back to it. Crabbox claims and runs the Static SSH lease from that same checkout, while the selected profile owns the remote work root. The adapter targets Linux/POSIX Static SSH hosts.

Static SSH does not support Crabbox port publishing. Set `network: 'direct'` only for a trusted target that shares the ViteHub process loopback network namespace; otherwise `getPortUrl()` reports that port forwarding is unavailable.

Crabbox validates requirements inside the selected environment. It does not make a filesystem, credential, network, or process isolation promise; those boundaries belong to the Crabbox provider and selected host.

## Related pages

- [Agent Drivers](/docs/agents/agent-drivers)
- [Workspace context](/docs/agents/workspace-context)
- [Sandbox](/docs/server-primitives/sandbox)
