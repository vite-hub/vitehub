---
title: Sandboxes
description: Run a built-in provider Driver inside a Sandbox with a private Home, checkout, credentials, and process requirements.
navigation.order: 75
navigation.group: Advanced
icon: i-lucide-package-open
navigation.kind: Guides
---

::agent-only{skill="sandbox"}
Use Sandboxes for trusted-host or provider-backed execution sessions. Sandboxes provide the execution boundary used by provider Agents and application code that needs an isolated project environment.

Read [Run your first Sandbox](/docs/agents/sandbox-tutorial) and [Choose a runtime](/docs/agents/sandboxes#choose-a-runtime).

Choose the provider and image, mounts, environment, commands, network, and resource bounds explicitly. A Sandbox is not a permission bypass. Keep credentials and Workspace access scoped to the run.

Prove command execution, cancellation, timeout, cleanup, and provider output for the target host.
::

A Sandbox is where a built-in provider Driver runs the Codex or Claude Code CLI. It prepares the working tree (the code folder), a private Home, environment variables, CLI state kept between runs, and boot checks. Use one when the provider needs more than a temporary local folder, such as an exact pull request checkout on another host. Start with [Run your first Sandbox](/docs/agents/sandbox-tutorial).

A Sandbox gives model-backed Drivers no Workspace tools; [Workspace context](/docs/agents/workspace-context) and Capabilities control those. The provider changes the working tree with its own tools, so treat the tree as visible to the model. The runtime gives the isolation.

## Start on a trusted host

Install the Agent and Sandbox packages:

```bash [Terminal]
pnpm add @vite-hub/agent @vite-hub/sandbox
```

This Agent gives Codex a private Home and checks the required CLIs before each Invocation (one run of the Agent):

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  sandbox: {
    runtime: 'trusted-host',
    requires: ['git'],
    toolchain: 'project',
  },
  driver: codexDriver(),
})
```

Each Invocation opens a new Sandbox session. It creates a private Home, installs the Node.js and package manager versions that the project pins, runs requirement checks, and starts the provider only after boot succeeds. The session closes when the Invocation ends.

:::warning
`trusted-host` isolates only the Home folder and declared environment values, not the filesystem, network, processes, or installed executables. Use it only when the Agent may act with the host user's authority.
:::

## Limit worker memory on Linux

A trusted-host Sandbox can limit memory for all session commands and their children in one cgroup v2 group:

```ts fragment
sandbox: {
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

`cgroupParent` must be writable, delegate the memory controller, and hold no processes. With systemd 254 or later, set `Delegate=memory` and `DelegateSubgroup=controller` and allow writes to delegated groups. Each Sandbox gets its own child group, with the ViteHub controller outside it. Without delegation, the limits fail closed: the Sandbox does not run. Swap defaults to zero.

When a worker runs out of memory (OOM), the kernel kills its command group. Command waits reject with `SANDBOX_R0158`, with the limit, peak memory, and OOM kill count. Later commands in that session fail, so reduce the workload before you retry. On close, ViteHub kills remaining children and removes the cgroup. Inspect the configuration with `sandbox.plan.resources`.

Limits cover session `exec` and `spawn`, including the provider's native tools. Checkout preparation, toolchain setup, requirement checks, and the trusted launcher's environment setup use the controller's service budget. The launcher joins the session cgroup before the command or any caller-controlled loader hooks run.

::warning
Keep a service limit as a second boundary. Trusted-host commands keep the host user's authority; resource limits are not a security sandbox.
::

## Pin an exact checkout

When every run must inspect an exact commit, read repository facts from trusted Invocation data, which Sandbox callbacks receive:

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

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
  sandbox: {
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
  driver: codexDriver(),
})
```

The Sandbox fetches `ref`, compares the commit with the full `sha`, and starts in a detached Git repository. When the caller owns the source-of-truth directory, use `cwd` instead; `cwd` and `checkout` do not combine.

## Provision Node.js and the package manager

A Sandbox does not need Node.js, a package manager, or Corepack on the host or image. With `toolchain: 'project'`, it reads pinned versions from the checkout or `cwd`:

```ts fragment
sandbox: {
  runtime: { kind: 'crabbox', profile: 'review' },
  checkout: { ref, remote, sha },
  toolchain: 'project',
}
```

The Node.js version comes from the first match:

1. `package.json` `devEngines.runtime`
2. `.node-version`
3. `.nvmrc`
4. `package.json` `volta.node`
5. `package.json` `engines.node`
6. `toolchain.fallbackNode`

Ranges and aliases such as `lts/*` resolve to the highest matching release. The package manager comes from `package.json` `packageManager` or `devEngines.packageManager`, else the npm bundled with Node.js. Pin versions in the Agent with `{ node: '22', packageManager: 'pnpm@10.2.0' }`, or keep bundled npm with `packageManager: false`.

ViteHub downloads official archives, verifies the Node.js `SHASUMS256.txt` checksum and npm registry `sha512` integrity, and caches each version. Installed `bin` directories go first on `PATH`, so no other host `node` runs, including for provider CLIs that start through `#!/usr/bin/env node`.

Boot fails when the project pins no Node.js version and no `fallbackNode` is set. See the [`@vite-hub/sandbox` README](https://github.com/vite-hub/vitehub/tree/main/packages/sandbox#provision-the-project-toolchain) for the cache location of each runtime, mirrors, and limits.

## Add credentials and CLI state

Keep secrets out of the repository. Load them into Sandbox `env`, Home files, or a first-use seed for writable state. The provider reads credentials from the Sandbox Home, such as `.codex/auth.json`.

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { useServerEnv } from '#vitehub/env/server'

export default defineAgent({
  sandbox: {
    runtime: {
      kind: 'trusted-host',
      stateRoot: '/var/lib/vitehub/sandboxes',
    },
    env: {
      GH_TOKEN: () => useServerEnv().githubToken.unseal(),
    },
    home: {
      files: {
        '.gitconfig': { from: '.vitehub/sandbox/gitconfig' },
        '.codex/config.toml': { from: '.vitehub/sandbox/codex.toml' },
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
  driver: codexDriver(),
})
```

| Declaration | Use it for | Lifecycle |
| --- | --- | --- |
| `env` | Tokens and CLI controls | Resolves each boot; reaches every Sandbox process. |
| `home.files` | Immutable configuration | Private files written each boot. |
| `home.state` | CLI-owned writable directories | Persists beneath `stateRoot` under an exclusive lease. |
| `seed` | First-use state | Resolves only when the state directory is absent. |
| `toolchain` | Project-pinned Node.js and package manager | Installs into a shared cache, or the Home on remote runtimes, before requirement checks. |
| `requires` | Executable and authentication checks | Runs after materialization; fails boot on error. |

Targets are relative POSIX paths below the Sandbox Home. State keys must be stable and include the project name. Existing state wins over its seed, so a failed authentication check does not restore older credentials.

Requirement objects use a fixed command and an argument array, not shell strings:

```ts
requires: [
  'git',
  'kubectl',
  { name: 'GitHub CLI', command: 'gh', args: ['auth', 'status'], timeout: 10_000 },
]
```

Do not put credentials in arguments, because anyone who can inspect requirement metadata can read them.

## Understand what the Driver adds

For each Invocation, the Driver adds to the Sandbox:

- `driver.instructions` at `.codex/AGENTS.md` (Codex) or `.claude/vitehub-system-prompt.md` (Claude Code) in the Home, leaving the checked-out tree unchanged.
- Colocated Skills in `.agents/skills`, `.codex/skills`, and `.claude/skills` in the Sandbox Home.
- The provider command as a requirement, `codex` or `claude` by default. `driver.providerSettings.binaryPath` sets another name or absolute path inside the Sandbox.
- `driver.env` values for the provider process, which replace Sandbox `env` values with the same name.

ViteHub rejects the Invocation when a declared Home file uses a path that the Driver writes.

A session lasts one Invocation, so the provider does not resume its session next time. Send the context it needs in the prompt, Home files, or the checkout.

## Choose a runtime

The runtime decides where commands run; the declaration stays the same. It must start long-running processes and forward their input.

| Runtime | Use it when |
| --- | --- |
| `trusted-host` | Trusted work may use the authority of the current machine. |
| `crabbox` | The same declaration must run through Crabbox Static SSH on a Linux host. |

Crabbox requires `cwd` or `checkout` and keeps its private Home on the target host. It copies back only a source-of-truth `cwd`; a disposable checkout stays on the target.

Capability tools reach the provider through a loopback MCP endpoint of the ViteHub process, so they need a runtime on the ViteHub network: `trusted-host`, or `crabbox` with `network: 'direct'`. Other runtimes reject Invocations with tools.

## Understand boot order

1. ViteHub validates names, paths, state keys, and requirement arguments without resolving secrets.
2. The runtime takes state leases and creates a private Home.
3. It resolves first-use seeds, environment values, and Home files.
4. It creates and verifies any configured checkout.
5. It provisions `toolchain`, puts it first on `PATH`, and verifies `node -v` and the package manager version.
6. It runs requirements, including the provider command, `node`, and the package manager.
7. The provider starts in the working directory.

A failed input or boot check stops the Invocation before the provider starts. Sandbox metadata excludes resolved secrets, file contents, physical Home paths, and provider handles.

## Know the limits

ViteHub rejects these combinations at definition:

| Combination | Reason |
| --- | --- |
| `sandbox` with a model or custom `run` Driver | Only built-in provider Drivers start a Sandbox process. |
| `sandbox` with `driver.launch` | The Sandbox starts the provider. |
| `sandbox` with `driver.credentials` or `driver.credentialProfile` | Use `sandbox.home.files`, `sandbox.home.state`, or `sandbox.env`. |
| `sandbox` with an Agent Workspace | The Sandbox `cwd` or `checkout` owns the working tree. |
| `sandbox` with `driver.toolchain` | Declare `sandbox.toolchain` instead. |
| `sandbox` on a Worker or Deno host | Provider Drivers need a Node.js host. |

When an Invocation starts, ViteHub rejects:

- a Windows host, because the provider relay requires a POSIX Node host
- image attachments, because the provider cannot read host attachment files
- managed `browser()`, which runs outside the Sandbox. Install the browser in the Sandbox and use `browser({ runtime: 'external' })`.
- Capability tools on a runtime outside the ViteHub network

The Invocation fails when the session cannot close, such as when a Crabbox Sandbox fails to copy provider changes back to a source-of-truth `cwd`.

Launch diagnostics hide resolved `sandbox.env` values. Home files and saved state can hold credentials, so when `sandbox.home.files` or `sandbox.home.state` has entries, saved provider stderr and spawn-error details are left out. Provider output still reaches the provider runtime.

## Keep execution boundaries separate

| Primitive | Owns |
| --- | --- |
| Agent `sandbox` | Process environment, private Home, credentials, checkout, state, and boot checks. |
| Workspace | Agent-visible files, Sources, rules, snapshots, and writeback. |
| `@vite-hub/sandbox` | Package-project discovery, preparation, invocation, timeout, and lifecycle orchestration. |

Use `@vite-hub/sandbox` directly when application code owns the process lifecycle. Use [`sandbox()`](/docs/sandbox/agent-capability) to give a model-backed Agent a tool that runs only allowlisted executables.

Provider status inside an Agent Sandbox is not inspectable yet: `agent.status()` reports `readiness: "unsupported"`, but the Invocation still runs in the Sandbox.

### Out-of-memory details

- Without kernel `memory.peak`, the diagnostic reports `peak=unavailable`.
- A local allocation OOM, even an allocation failure without a kill, invalidates the session, because it shows the session used its whole budget. This works with `memory_localevents` mounts.
- A kill by a parent group or the host alone does not invalidate the session.
- The reported `memory.events` kill count is context, not proof of the cause. On `memory_localevents` mounts, it can leave out killed children.
- Nested cgroups are removed on close.
- The launcher restores the command environment only after it joins the session group.
