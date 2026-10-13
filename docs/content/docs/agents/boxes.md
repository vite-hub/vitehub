---
title: Boxes
description: Run a built-in provider Driver inside a Box with a private Home, checkout, credentials, and process requirements.
navigation.order: 50
navigation.group: Advanced execution
icon: i-lucide-package-open
---

A Box prepares the process environment for a built-in provider Driver. It declares the working tree, private Home, environment, durable CLI state, and boot checks. The Codex or Claude Code process then starts inside the Box.

For a first working result, follow [Run your first Box](/docs/agents/box-tutorial).

Use a Box when the provider needs more than a temporary local directory. For example, use a Box when it must work in an exact pull request checkout on another host. A Box does not give model-backed Drivers Workspace tools. [Workspace context](/docs/agents/workspace-context) and Capabilities own that boundary. The provider can read and change the Box working tree with its native file and command tools. Treat that tree as model-visible, and rely on the selected Box runtime for isolation.

## Start on a trusted host

Install the Agent and Box packages:

```bash [Terminal]
pnpm add @vite-hub/agent @vite-hub/box
```

This Agent gives Codex a private Home and checks the required CLIs before the invocation starts:

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  box: {
    runtime: 'trusted-host',
    requires: ['git'],
    toolchain: 'project',
  },
  driver: { kind: 'codex' },
})
```

For each invocation, ViteHub opens a new Box session. The Box creates a private Home, provisions the Node.js and package manager versions that the project pins, runs its requirements, and starts the provider only after boot succeeds. ViteHub closes the session when the invocation ends.

:::warning
`trusted-host` isolates Home and declared environment values. It does not isolate the filesystem, network, processes, or installed executables. Use it only when the Agent may act with the authority of the host user.
:::

## Limit worker memory on Linux

A trusted-host Box can cap all session commands and their descendants in one cgroup v2 group:

```ts
box: {
  runtime: {
    kind: 'trusted-host',
    resources: {
      cgroupParent: '/sys/fs/cgroup/system.slice/agent.service',
      memoryHighBytes: 3 * 1024 ** 3,
      memoryMaxBytes: 4 * 1024 ** 3,
      memorySwapMaxBytes: 128 * 1024 ** 2,
    },
  },
},
```

The parent must be writable, must delegate the memory controller, and must have no resident processes. With systemd 254 or later, configure `Delegate=memory` and `DelegateSubgroup=controller` and allow writes to the delegated control groups. Each Box creates a separate child group. The ViteHub controller remains outside the worker group. Configured limits fail closed if delegation is unavailable. Swap defaults to zero.

A worker OOM kills its command group. Command waits reject with `BOX_R0158`, including the limit, peak memory and OOM kill count. Further commands in that session fail. Reduce the workload before retrying. Session close kills all remaining descendants and removes the cgroup. Inspect the configuration with `box.plan.resources`.

These limits cover session `exec` and `spawn`, including the provider's native tools. Checkout preparation, toolchain setup and requirement checks remain under the controller's service budget. The trusted launcher also prepares its environment under that budget, then joins the session cgroup before executing the command or any caller-controlled loader hooks. Keep a service limit as a second boundary. Trusted-host commands retain host user authority; resource limits do not provide a security sandbox.

## Pin an exact checkout

Box callbacks receive the Agent invocation context. Resolve repository facts from trusted invocation data when every run must inspect an exact commit.

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'

interface PullRequest {
  ref: string
  remote: string
  sha: string
}

function pullRequestOf(context: { input: { context?: Record<string, unknown> } }) {
  const value = context.input.context?.pullRequest as PullRequest | undefined
  if (!value) throw new Error('A trusted pull request context is required.')
  return value
}

export default defineAgent({
  box: {
    runtime: { kind: 'crabbox', profile: 'review' },
    checkout: {
      ref: context => pullRequestOf(context).ref,
      remote: context => pullRequestOf(context).remote,
      sha: context => pullRequestOf(context).sha,
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
  driver: { kind: 'codex' },
})
```

The Box fetches `ref`, compares the fetched commit with the full `sha`, and starts in a detached Git repository. Use `cwd` when the caller already owns the authoritative directory. `cwd` and `checkout` are mutually exclusive.

## Provision Node.js and the package manager

A Box does not assume that the host or image has Node.js, a package manager, or Corepack. Set `toolchain: 'project'` and the Box reads the pins from the checkout or `cwd`:

```ts
box: {
  runtime: { kind: 'crabbox', profile: 'review' },
  checkout: { ref, remote, sha },
  toolchain: 'project',
}
```

Node.js comes from the first match: `package.json` `devEngines.runtime`, `.node-version`, `.nvmrc`, `package.json` `volta.node`, `package.json` `engines.node`, then `toolchain.fallbackNode`. Ranges and aliases such as `lts/*` resolve to the highest matching release. The package manager comes from `package.json` `packageManager` or `devEngines.packageManager`; without one, the project uses the npm bundled with Node.js. Use `{ node: '22', packageManager: 'pnpm@10.2.0' }` to pin versions in the Agent, or `packageManager: false` to keep the bundled npm.

ViteHub downloads official archives, verifies the Node.js `SHASUMS256.txt` checksum and the npm registry `sha512` integrity, and caches each version. The provisioned `bin` directories come first on the Box `PATH`, so a different `node` on the host never answers. Boot fails when the project pins no Node.js version and no `fallbackNode` is set. See the [`@vite-hub/box` README](https://github.com/vite-hub/vitehub/tree/main/packages/box#provision-the-project-toolchain) for the cache location of each runtime, mirrors, and limits.

Provider CLIs that start through `#!/usr/bin/env node` also run on the provisioned Node.js.

## Add credentials and CLI state

Keep secret values outside the repository. Resolve them into Box `env`, Home files, or a first-use seed for writable state. The provider reads its credentials from the Box Home, for example `.codex/auth.json`.

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'
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
  driver: { kind: 'codex' },
})
```

| Declaration | Use it for | Lifecycle |
| --- | --- | --- |
| `env` | Tokens and CLI controls | Resolves on every boot and reaches every Box process. |
| `home.files` | Immutable configuration | Writes private files on every boot. |
| `home.state` | CLI-owned writable directories | Persists beneath `stateRoot` under an exclusive lease. |
| `seed` | First-use state | Resolves only when the durable state directory is absent. |
| `toolchain` | Project-pinned Node.js and package manager | Installs into a shared cache, or the Box Home on remote runtimes, before requirement checks. |
| `requires` | Executable and authentication checks | Runs after materialization and fails boot on error. |

Targets are relative POSIX paths below the Box Home. State keys must be stable and project-qualified. Existing state wins over its seed, so a failed authentication check does not restore older credentials.

Requirement objects use fixed command and argument arrays. They do not parse shell strings:

```ts
requires: [
  'git',
  'kubectl',
  { name: 'GitHub CLI', command: 'gh', args: ['auth', 'status'], timeout: 10_000 },
]
```

Keep credentials out of arguments because requirement metadata is inspectable.

## Understand what the Driver adds

The Driver adds these items to the Box for each invocation:

- `driver.instructions` go to `.codex/AGENTS.md` for Codex or `.claude/vitehub-system-prompt.md` for Claude Code in the Box Home. The checked-out tree does not change.
- Colocated Skills go to `.agents/skills`, `.codex/skills`, and `.claude/skills` in the Box Home.
- The provider command becomes a Box requirement. It is `codex` or `claude` by default. Set `driver.providerSettings.binaryPath` to use another command name or absolute path inside the Box.
- `driver.env` values reach the provider process in the Box. They replace Box `env` values with the same name.

Do not declare Home files at the paths that the Driver writes. ViteHub rejects the invocation when a declared Home file uses one of these paths.

A Box session lasts one invocation, so the provider does not resume its session in the next invocation. Send the necessary context in the prompt, Home files, or the checkout.

## Choose a runtime

The Box declaration stays portable while the runtime decides where commands run. The runtime must start long-running processes and forward their input.

| Runtime | Use it when |
| --- | --- |
| `trusted-host` | Trusted work may use the authority of the current machine. |
| `crabbox` | The same declaration must run through Crabbox Static SSH on a Linux host. |

Crabbox requires `cwd` or `checkout`, keeps its private Home on the target, and synchronizes only an authoritative `cwd` back. A disposable checkout stays on the target.

Capability tools reach the provider through a loopback MCP endpoint of the ViteHub process. Use them only with a runtime that shares the ViteHub network: `trusted-host`, or `crabbox` with `network: 'direct'`. Other runtimes reject invocations that include tools.

## Understand boot order

1. ViteHub validates names, paths, state keys, and requirement arguments without resolving secrets.
2. The runtime acquires state leases and creates a private Home.
3. It resolves first-use seeds, environment values, and Home files for this invocation.
4. It creates and verifies the checkout when configured.
5. It provisions `toolchain` from the checkout or `cwd`, puts it first on `PATH`, and verifies `node -v` and the package manager version.
6. It runs requirements, including the provider command, `node`, and the package manager, inside the prepared environment.
7. The provider starts in the Box working directory.

A failed input or boot check stops the invocation before the provider starts. Box metadata excludes resolved secret values, file contents, physical Home paths, and provider handles.

## Know the limits

ViteHub rejects these combinations when you define the Agent:

| Combination | Reason |
| --- | --- |
| `box` with a model or custom `run` Driver | Only built-in provider Drivers start a process in the Box. |
| `box` with `driver.launch` | The Box starts the provider. |
| `box` with `driver.credentials` or `driver.credentialProfile` | Put provider credentials in `box.home.files`, `box.home.state`, or `box.env`. |
| `box` with an Agent Workspace | The Box `cwd` or `checkout` owns the working tree. |
| `box` with `driver.toolchain` | Declare `box.toolchain` so the Box provisions it. |
| `box` on a Worker or Deno host | Provider Drivers need a Node.js host. |

ViteHub rejects these inputs when an invocation starts:

- A Windows host, because the provider relay requires a POSIX Node host.
- Image attachments, because the provider cannot read host attachment files.
- Managed `browser()`, because the browser runs outside the Box. Install the browser in the Box and use `browser({ runtime: 'external' })`.
- Capability tools on a runtime that does not share the ViteHub network.

The invocation fails when the Box session cannot close. For example, a Crabbox Box with an authoritative `cwd` copies provider changes back when it closes, so a failed copy is reported.

Launch diagnostics redact resolved `box.env` values. When `box.home.files` or `box.home.state` has entries, ViteHub omits saved provider stderr and spawn-error details because Home files and persisted state can contain credentials. Provider output still reaches the provider runtime.

## Keep execution boundaries separate

| Primitive | Owns |
| --- | --- |
| Box | Process environment, private Home, credentials, checkout, state, and boot checks. |
| Workspace | Agent-visible files, Sources, rules, snapshots, and writeback. |
| Sandbox | Package-project discovery, preparation, invocation, timeout, and lifecycle orchestration. |

Use `@vite-hub/box` directly when application code owns the process lifecycle. Use [`sandbox()`](/docs/sandbox/agent-capability) to give a model-backed Agent an allowlisted executable tool.

Provider status inspection inside an Agent Box is currently unsupported. `agent.status()` reports `readiness: "unsupported"` for boxed provider Drivers. Invocation execution still uses the configured Box.

On kernels without `memory.peak`, the OOM diagnostic reports `peak=unavailable`. Box invalidates the session on a local allocation OOM, including allocation failures without a kill. This signal identifies exhaustion of the session budget and works with `memory_localevents` mounts. Ancestor or host kills alone do not invalidate it. The diagnostic reports the observed `memory.events` kill count as context, not proof of the kill cause; that count can exclude descendant victims on `memory_localevents` mounts. Box removes nested cgroups during close. The launcher restores the command environment only after joining the session group.
