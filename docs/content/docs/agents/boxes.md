---
title: Boxes
description: Prepare one portable Home and process environment for every harness and command.
navigation.order: 22.5
icon: i-lucide-package-open
---

A Box is the execution environment for a harness Agent. The project declares what the Box needs, and the runtime prepares one private Home and process environment before any harness bootstrap or command runs.

Use `trustedHost()` when the Agent may use the current host's filesystem, processes, and installed executables. Use `crabbox()` to run the same Box declaration through Crabbox Static SSH. Neither runtime reads credentials or configuration from the machine's normal Home.

## Run Codex in an existing checkout

Install the Agent and Box packages with the Codex harness adapter:

```bash [Terminal]
pnpm add @vite-hub/agent @vite-hub/box @ai-sdk/harness @ai-sdk/harness-codex
```

Declare the checkout, immutable inputs, writable state, and validation checks together:

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from "@vite-hub/agent";
import { codexDriver } from "@vite-hub/agent/harness/codex";
import { trustedHost } from "@vite-hub/box";
import { useServerEnv } from "#vitehub/env/server";

interface BabysitterRunOptions {
  worktreePath: string;
}

export default defineAgent<any, BabysitterRunOptions>({
  box: {
    runtime: trustedHost({ stateRoot: "/var/lib/vitehub/boxes" }),
    cwd: ({ input }) => input.options?.worktreePath,
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
  driver: codexDriver(),
});
```

The runtime creates an owner-only Home outside the checkout, sets the XDG directories beneath it, and exposes the same environment to Codex, Git, `gh`, MCP servers, and ordinary Box commands. `codexDriver()` uses `$HOME/.codex` directly and contributes `codex login status` automatically, so Codex refreshes remain in Box state.

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
6. The runtime runs requirements inside that environment.
7. Only a successful Box is exposed to harness bootstrap and commands.

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
import { crabbox } from '@vite-hub/box/crabbox'

box: {
  runtime: crabbox({
    profile: 'babysitter',
    stateRoot: '/var/lib/vitehub/boxes',
  }),
  cwd: ({ input }) => input.options?.worktreePath,
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

Crabbox creates the private Home on the target and sends resolved material through its protected stdin channel. Its `stateRoot` is an absolute target-host path and remains outside Workspace synchronization. The runtime creates private children without changing permissions on an existing caller-owned root. Only the authoritative `cwd` is synchronized back.

Crabbox requires `cwd` and targets Linux/POSIX Static SSH hosts. Static SSH does not provide port publishing; set `network: 'direct'` only when the target shares the ViteHub process loopback namespace.

Commands must remain owned by their Box session. Daemonizing or escaping the session's process supervision is outside the v1 concurrency guarantee.

On a VPS, the Agent definition is the boot declaration. The invocation path creates and validates its Box session before in-session harness bootstrap, MCP servers, or user commands run, so the service must not provision a separate auth Home or launch commands outside that session. `stateRoot` is the only host-owned storage that must exist across service restarts; the runtime creates its private contents and session leases.

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
| Box       | Process environment, private Home, immutable inputs, writable CLI state, working checkout, and boot checks. |
| Workspace | Model-visible file context, Sources, rules, snapshots, and writeback.                                       |
| Sandbox   | Provider isolation for untrusted code.                                                                      |

An explicit Box `cwd` cannot be combined with Agent Workspace materialization because both would own the working tree. Omit `cwd` when an Agent Workspace should be materialized into a disposable Box session.

Home and environment isolation do not isolate the filesystem, network, installed executables, or trusted project code. Use `trustedHost()` only when the Agent may act with the host user's authority.

V1 deliberately stops at env values, Home files, writable directory state, and direct boot checks. Secret-manager registries, a ViteHub encryption format, live rotation, per-command credential narrowing, keychain forwarding, and provider-specific auth helpers can be added outside core or later when a concrete runtime needs them.

## Related pages

- [Agent Drivers](/docs/agents/agent-drivers)
- [Workspace context](/docs/agents/workspace-context)
- [Sandbox](/docs/server-primitives/sandbox)
