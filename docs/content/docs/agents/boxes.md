---
title: Boxes
description: Prepare a private Home, checkout, credentials, and process requirements for a harness Agent.
navigation.order: 50
navigation.group: Advanced execution
icon: i-lucide-package-open
---

A Box prepares the process environment for a harness Agent. It declares the working tree, private Home, environment, durable CLI state, and boot checks before the harness starts.

Use a Box when the Agent needs more than an ephemeral harness workspace. A Box does not grant model-facing file access; [Workspace context](/docs/agents/workspace-context) and Capabilities own that boundary.

## Start on a trusted host

Install the Agent and Box packages:

```bash [Terminal]
pnpm add @vite-hub/agent @vite-hub/box
```

This Agent gives Codex a private Home and verifies its required CLIs before the invocation begins:

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  box: {
    runtime: 'trusted-host',
    requires: ['git', 'pnpm'],
  },
  driver: 'codex',
})
```

For each invocation, the Box creates a private Home, runs its requirements, and starts the harness only after boot succeeds.

:::warning
`trusted-host` isolates Home and declared environment values, but it does not isolate the filesystem, network, processes, or installed executables. Use it only when the Agent may act with the host user's authority.
:::

## Pin an exact checkout

Resolve repository facts from trusted invocation options when every run must inspect an exact commit.

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'

interface ReviewOptions {
  ref: string
  remote: string
  sha: string
}

export default defineAgent<any, ReviewOptions>({
  box: {
    runtime: {
      kind: 'trusted-host',
      stateRoot: '/var/lib/vitehub/boxes',
    },
    checkout: {
      ref: ({ input }) => input.options?.ref,
      remote: ({ input }) => input.options?.remote,
      sha: ({ input }) => input.options?.sha,
    },
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    requires: [
      'git',
      { name: 'GitHub CLI', command: 'gh', args: ['auth', 'status'] },
    ],
  },
  driver: 'codex',
})
```

The Box fetches `ref`, verifies the fetched commit against the full `sha`, and starts in a detached real Git repository. Use `cwd` instead when the caller already owns the authoritative directory; `cwd` and `checkout` are mutually exclusive.

## Add credentials and CLI state

Keep secret values outside the repository. Resolve them into Box `env`, immutable Home files, or a first-use seed for writable state.

```ts [server/agents/review/agent.ts]
import { useServerEnv } from '#vitehub/env/server'

export default defineAgent({
  box: {
    runtime: {
      kind: 'trusted-host',
      stateRoot: '/var/lib/vitehub/boxes',
    },
    env: {
      GH_TOKEN: () => useServerEnv().githubToken.unseal(),
    },
    home: {
      files: {
        '.gitconfig': { from: '.vitehub/box/gitconfig' },
        '.codex/config.toml': { from: '.vitehub/box/codex.toml' },
      },
      state: {
        '.codex': {
          key: 'review/codex',
          seed: {
            'auth.json': {
              contents: () => useServerEnv().codexAuthJson.unseal(),
            },
          },
        },
      },
    },
  },
  driver: 'codex',
})
```

| Declaration | Use it for | Lifecycle |
| --- | --- | --- |
| `env` | Tokens and CLI controls | Resolves on every boot and reaches every Box process. |
| `home.files` | Immutable configuration | Writes private files on every boot. |
| `home.state` | CLI-owned writable directories | Persists beneath `stateRoot` under an exclusive lease. |
| `seed` | First-use state | Resolves only when the durable state directory is absent. |
| `requires` | Executable and authentication checks | Runs after materialization and fails boot on error. |

Targets are relative POSIX paths below the Box Home. State keys should be stable and project-qualified. Existing state wins over its seed, so a failed authentication check never silently restores older credentials.

Requirement objects use fixed command and argument arrays; they do not parse shell strings:

```ts
requires: [
  'git',
  'kubectl',
  { name: 'GitHub CLI', command: 'gh', args: ['auth', 'status'], timeout: 10_000 },
]
```

Keep credentials out of arguments because requirement metadata is inspectable.

## Choose a runtime

The Box declaration remains portable while the runtime decides where commands execute.

| Runtime | Use it when |
| --- | --- |
| `trusted-host` | Trusted work may use the current machine's authority. |
| `crabbox` | The same declaration should run through Crabbox Static SSH on a Linux host. |
| Tagged hosted runtime | The Agent should use a configured ASCII, Cloudflare Sandbox, Cloudflare Computer, or Vercel Sandbox provider. |

Crabbox requires `cwd` or `checkout`, keeps its private Home on the target, and synchronizes only an authoritative `cwd` back. A disposable checkout remains target-local.

Cloudflare Computer is currently a preview and its Worker shell backend does not provide the Linux userland required by Node.js, Git, package managers, or Codex. Use a configured Container backend for those commands and inspect the provider's isolation and secret boundary before production use.

## Understand boot order

1. ViteHub validates names, paths, state keys, and requirement arguments without resolving secrets.
2. The runtime acquires state leases and creates a private Home.
3. It resolves first-use seeds, environment values, and Home files.
4. It creates and verifies the checkout when configured.
5. It runs requirements inside the prepared environment.
6. Only a successful Box is exposed to the harness.

Any required input or boot check failure stops the invocation before harness execution. Box metadata excludes resolved secret values, file contents, physical Home paths, and provider handles.

## Keep execution boundaries separate

| Primitive | Owns |
| --- | --- |
| Box | Process environment, private Home, credentials, checkout, state, and boot checks. |
| Workspace | Agent-visible files, Sources, rules, snapshots, and writeback. |
| Sandbox | Package-project discovery, preparation, invocation, timeout, and lifecycle orchestration. |

Do not combine Box `cwd` or `checkout` with Agent Workspace materialization because both would own the working tree. Omit them when the Workspace should materialize into a disposable Box session.
