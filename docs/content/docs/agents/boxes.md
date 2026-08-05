---
title: Boxes
description: Prepare one portable Home and process environment for every harness and command.
navigation.order: 22.5
icon: i-lucide-package-open
---

A Box is the execution environment for a harness Agent. The project declares what the Box needs, and the runtime prepares one private Home and process environment before any harness bootstrap or command runs.

Use `"trusted-host"` when the Agent may use the current host's filesystem, processes, and installed executables. Use `"crabbox"` to run the same Box declaration through Crabbox Static SSH. Hosted runtimes use tagged values for ASCII, Cloudflare Sandbox, Cloudflare Computer, or Vercel Sandbox. No runtime reads credentials or configuration from the machine's normal Home.

## Run Codex in an exact disposable checkout

Install the Agent and Box packages. The Agent Package includes the supported Codex adapter:

```bash [Terminal]
pnpm add @vite-hub/agent @vite-hub/box
```

Declare the checkout, immutable inputs, writable state, and validation checks together:

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from "@vite-hub/agent";
import { useServerEnv } from "#vitehub/env/server";

interface BabysitterRunOptions {
  ref: string;
  remote: string;
  sha: string;
}

export default defineAgent<any, BabysitterRunOptions>({
  box: {
    runtime: { kind: "trusted-host", stateRoot: "/var/lib/vitehub/boxes" },
    checkout: {
      ref: ({ input }) => input.options?.ref,
      remote: ({ input }) => input.options?.remote,
      sha: ({ input }) => input.options?.sha,
    },
    env: {
      GH_TOKEN: () => useServerEnv().githubToken.unseal(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    home: {
      files: {
        ".gitconfig": { from: ".vitehub/box/gitconfig" },
        ".codex/config.toml": { from: ".vitehub/box/codex.toml" },
      },
      state: {
        ".codex": {
          key: "babysitter/codex",
          seed: {
            "auth.json": {
              contents: () => useServerEnv().codexAuthJson.unseal(),
            },
          },
        },
      },
    },
    requires: [{ name: "GitHub CLI", command: "gh", args: ["auth", "status"] }, "pnpm"],
  },
  driver: "codex",
});
```

For every invocation, `checkout` fetches `ref` from `remote`, verifies the fetched commit against the full `sha`, and starts Codex in a detached real Git repository. The checkout supports ordinary commits and explicit pushes such as `git push origin HEAD:<branch>`, then the Box deletes it on completion or boot failure. For a fork pull request, use the fork repository as `remote`; keep credentials in Box env or Home instead of embedding them in the remote URL.

Use `cwd` instead when the caller already owns an authoritative directory. `checkout` and `cwd` are mutually exclusive. Git is an implicit checkout requirement and appears in resolved Box metadata.

The runtime creates an owner-only Home outside the checkout, sets the XDG directories beneath it, and exposes the same environment to Codex, Git, `gh`, MCP servers, and ordinary Box commands. The `"codex"` driver uses `$HOME/.codex` directly and contributes `codex login status` automatically, so Codex refreshes remain in Box state.

The example's committed `.vitehub/box/gitconfig` can configure Git without containing a token:

```gitconfig [.vitehub/box/gitconfig]
[credential "https://github.com"]
  helper = !gh auth git-credential
```

The helper consumes the same declared `GH_TOKEN` as `gh`. Core does not need GitHub- or Codex-specific authentication helpers.

## Choose the correct lifecycle

| Declaration  | Use it for                                                                | Boot behavior                                                  |
| ------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `env`        | Tokens such as `GH_TOKEN` and non-secret CLI controls                     | Resolves every boot and reaches every Box process.             |
| `home.files` | Committed config, opaque credential files, and project-generated settings | Writes private files atomically every boot.                    |
| `home.state` | OAuth caches and other CLI-owned writable directories                     | Attaches durable state under an exclusive session lease.       |
| `seed`       | First-use state such as an imported `auth.json`                           | Resolves only when the durable state directory does not exist. |
| `requires`   | Executable checks and safe authentication status commands                 | Runs after materialization and aborts boot on failure.         |

Targets are relative POSIX paths below Home. A `{ from }` source is relative to `cwd`, or the ViteHub process directory when `cwd` is omitted. A `{ contents }` source accepts text, bytes, or a `BoxValue` callback. All declared values are required.

Files may be projected beneath a state directory. The runtime attaches state first and applies immutable files afterward, which lets `.codex/config.toml` remain project-controlled while `.codex/auth.json` remains writable.

State keys identify durable data within the runtime's `stateRoot`. Use stable project-qualified keys such as `babysitter/codex`. A second session requesting the same state waits until the first session stops its processes and releases the lease. Existing state always wins over its seed, including when an authentication check later rejects it; ViteHub never silently rolls refreshed credentials back.

## Keep projects public safely

A public repository may contain:

- Box declarations and target paths.
- Non-secret native configuration such as `.gitconfig` and `config.toml`.
- Optional ciphertext decrypted during a `contents` callback.

It must not contain plaintext bearer credentials or the capability that decrypts committed ciphertext. Supply that root capability through Server Env, workload identity, an interactive unlock, or another deployment-owned source.

Resolved env values, materialized file contents, mutable state, decryption capabilities, physical Home paths, and sandbox handles are excluded from serialized Box metadata and ViteHub-generated workspaces or artifacts. Requirement failures discard command output, and Crabbox sends materialization bytes over stdin instead of command arguments. Every process inside the Box remains trusted and can still read or log its credentials.

## Understand fail-closed boot

Box boot follows one order:

1. ViteHub validates declaration names, paths, state keys, and requirement argv without resolving secret bytes.
2. The runtime acquires state leases and creates a private Home.
3. The runtime inspects existing state and resolves seeds only for missing state.
4. The runtime resolves env and files; if any required input fails, no new state becomes authoritative.
5. The runtime attaches state, writes files with private permissions, and builds a sanitized environment.
6. When declared, the runtime creates the disposable Git checkout and verifies its exact SHA.
7. The runtime runs requirements inside that environment.
8. Only a successful Box is exposed to harness bootstrap and commands.

`HOME`, the XDG paths, and working-directory variables are runtime-owned and cannot be declared or overridden by a command. The runtime inherits a small operational allowlist such as `PATH`, shell, locale, and temporary-directory variables; it does not spread the launcher process environment. An absent declaration cannot be masked by a host token or dotfile.

Some CLIs can also consult system configuration or an operating-system keychain. Select their file- or environment-backed mode through ordinary project config and validate that mode with `requires`. For Codex, set `cli_auth_credentials_store = "file"`. For Git, the example disables system config and terminal prompting through declared env.

## Check arbitrary CLIs

A string checks only that an executable exists. An object supplies a fixed command and argv, so the runtime never parses a project-supplied shell command:

```ts
requires: [
  "git",
  "kubectl",
  { name: "GitHub CLI", command: "gh", args: ["auth", "status"] },
  { name: "Acme CLI", command: "acme", args: ["auth", "status"] },
];
```

An arbitrary CLI can consume a declared env value, a native file such as `.kube/config`, or both. If it later refreshes files, move its writable directory to `home.state`; the Box API does not change.

Requirement names, commands, and argv are inspectable declaration metadata, so keep credentials in `env` or Home files rather than arguments.

## Run through Crabbox

Crabbox accepts the same Box declaration:

```ts
box: {
  runtime: {
    kind: 'crabbox',
    profile: 'babysitter',
    stateRoot: '/var/lib/vitehub/boxes',
  },
  checkout: {
    ref: ({ input }) => input.options?.ref,
    remote: ({ input }) => input.options?.remote,
    sha: ({ input }) => input.options?.sha,
  },
  env: {
    GH_TOKEN: () => useServerEnv().githubToken.unseal(),
  },
  home: {
    files: {
      '.gitconfig': { from: '.vitehub/box/gitconfig' },
    },
  },
}
```

Crabbox creates the private Home on the target and sends resolved material through its protected stdin channel. Its `stateRoot` is an absolute target-host path and remains outside Workspace synchronization. The runtime creates private children without changing permissions on an existing caller-owned root. An authoritative `cwd` is synchronized back; a disposable `checkout` remains target-local and is deleted with the Box session.

Crabbox requires either `cwd` or `checkout` and targets Linux/POSIX Static SSH hosts. File reads and writes use Crabbox's resolved SSH copy transport. Port URLs wait for and reuse one loopback-only Crabbox tunnel per port by default, and session teardown stops those tunnels. Set `network: 'direct'` only when the target shares the ViteHub process loopback namespace.

Commands must remain owned by their Box session. Daemonizing or escaping the session's process supervision is outside the v1 concurrency guarantee.

On a VPS, the Agent definition is the boot declaration. The invocation path creates and validates its Box session before in-session harness bootstrap, MCP servers, or user commands run, so the service must not provision a separate auth Home or launch commands outside that session. `stateRoot` is the only host-owned storage that must exist across service restarts; the runtime creates its private contents and session leases.

## Run through Cloudflare Computer

Cloudflare Computer stores an authoritative virtual filesystem in a Durable Object and runs commands through a selected Computer backend. ViteHub adapts that filesystem and command surface to a Box session, so Agent definitions keep the same `env`, `home.files`, `checkout`, and `requires` declarations.

::warning
Cloudflare Computer is currently a preview. Its API is unstable, and Cloudflare does not recommend it for production workloads yet.
::

Install Computer beside the Box package:

```bash [Terminal]
pnpm add @vite-hub/box @cloudflare/computer
```

Configure the Durable Object with `@cloudflare/computer` before selecting it from a Box. The Durable Object must use `withWorkspace()` and register at least one shell backend; ViteHub does not generate the Computer class, Worker Loader binding, Container configuration, or Durable Object migration.

```ts [src/agent-computer.ts]
import { withWorkspace } from '@cloudflare/computer'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { DurableObject } from 'cloudflare:workers'

export { WorkspaceServiceProxy } from '@cloudflare/computer'

export class AgentComputer extends withWorkspace(
  class extends DurableObject<Env> {},
  self => ({
    storage: self.ctx.storage,
    backends: [
      new WorkerShellBackend({
        loader: self.env.LOADER,
        workspace: {
          binding: 'AGENT_COMPUTER',
          id: self.ctx.id.toString(),
        },
        ctx: self.ctx,
      }),
    ],
  }),
) {}
```

Add the Durable Object, migration, Worker Loader binding, and required compatibility flags to the Cloudflare deployment configuration:

```jsonc [wrangler.jsonc]
{
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "durable_objects": {
    "bindings": [
      { "name": "AGENT_COMPUTER", "class_name": "AgentComputer" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AgentComputer"] }
  ],
  "worker_loaders": [
    { "binding": "LOADER" }
  ]
}
```

Pass the Durable Object namespace to the Box and select the registered backend by ID:

```ts [src/index.ts]
import { resolveBox } from '@vite-hub/box'

export default {
  async fetch(_request: Request, env: Env) {
    const box = await resolveBox({
      runtime: {
        kind: 'cloudflare-computer',
        namespace: env.AGENT_COMPUTER,
        backend: 'worker-shell',
      },
    }, {})
    const session = await box.open({ id: 'agent-123' })

    try {
      return Response.json(await session.exec('ls', ['-la']))
    }
    finally {
      await session.close()
    }
  },
} satisfies ExportedHandler<Env>
```

The Worker shell backend uses `just-bash` in an isolate. It does not provide the full Linux userland required by Node.js, package managers, Git, Codex, or other native CLIs. Select a configured Computer Container backend for those commands, and use its registered backend ID in the Box declaration.

ViteHub derives the Durable Object name from `box.open({ id })`. It resets `/home/vitehub` and `/workspace`, materializes the Box declaration, and runs requirement checks through the selected backend. Closing the Box stops active executions, clears those managed roots, and disposes Computer RPC handles without deleting the Durable Object or files elsewhere in its authoritative filesystem.

Computer chooses the execution backend at runtime, so ViteHub reports its isolation, network, process, and credential authority as unknown. Inspect the selected Computer backend and deployment configuration before giving the Box secrets or untrusted code.

## Migrate from path-valued `home`

Path-valued `box.home` and ambient Home fallback have been removed. Migrate in this order:

1. Move non-secret dotfiles from the managed Home into a committed directory such as `.vitehub/box`.
2. Bind immutable credentials through `env` or `home.files` using Server Env callbacks.
3. Import only writable CLI state, such as `.codex`, into the runtime's protected `stateRoot` under its declared key.
4. Replace `home: '/srv/vitehub/home'` with structured `home.files` and `home.state`.
5. Delete the old Home provisioning or synchronization path after the new requirement checks pass.

Do not copy a general user Home into Box state. It mixes unrelated credentials and config into one trust boundary, makes rotation unclear, and restores ambient behavior under a managed path.

## Keep execution boundaries separate

| Primitive | Owns                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Box       | Provider isolation, process environment, private Home, immutable inputs, writable CLI state, working checkout, and boot checks. |
| Workspace | Model-visible file context, Sources, rules, snapshots, and writeback.                                       |
| Sandbox   | Named package-project discovery, preparation, invocation, timeout, and lifecycle orchestration.              |

Box `cwd` and `checkout` cannot be combined with Agent Workspace materialization because each owns the working tree. Omit both when an Agent Workspace should be materialized into a disposable Box session.

Home and environment isolation do not isolate the filesystem, network, installed executables, or trusted project code. Use `"trusted-host"` only when the Agent may act with the host user's authority.

V1 deliberately stops at env values, Home files, writable directory state, generic Git checkout, and direct boot checks. Secret-manager registries, a ViteHub encryption format, live rotation, per-command credential narrowing, keychain forwarding, and provider-specific auth helpers can be added outside core or later when a concrete runtime needs them.

## Related pages

- [Agent Drivers](/docs/agents/agent-drivers)
- [Workspace context](/docs/agents/workspace-context)
- [Cloudflare host configuration](/docs/frameworks-hosts/cloudflare)
- [Sandbox](/docs/server-primitives/sandbox)
