# @vite-hub/box

`@vite-hub/box` prepares one portable execution environment for every harness and command in a ViteHub Agent. A project declares environment inputs, immutable Home files, writable Home state, and boot checks; the selected runtime materializes them without reading the machine's normal Home.

## Install

```sh
pnpm add @vite-hub/box
```

## Prepare a trusted-host Box

```ts
import { defineAgent } from "@vite-hub/agent";
import { codexDriver } from "@vite-hub/agent/harness/codex";
import { trustedHost } from "@vite-hub/box";
import { useServerEnv } from "#vitehub/env/server";

export default defineAgent<any, { ref: string; remote: string; sha: string }>({
  box: {
    runtime: trustedHost({ stateRoot: "/var/lib/vitehub/boxes" }),
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
  driver: codexDriver(),
});
```

`checkout` gives each invocation a disposable real Git repository at the exact requested commit. The runtime fetches `ref` from `remote`, verifies the resulting commit against the full `sha`, and starts the harness in a detached checkout. Normal Git commits work, and callers can push explicitly with `git push origin HEAD:<branch>`. Use the source repository as `remote` for fork pull requests, and keep credentials in Box `env` or Home rather than embedding them in the remote URL.

`checkout` and `cwd` are mutually exclusive. Use `cwd` for a caller-owned authoritative directory; use `checkout` when the Box should create, isolate, and delete the working tree. Git is an implicit checkout requirement and is included in resolved Box metadata.

Every Box session receives a new private `HOME` plus `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME`. The runtime starts from a small operational environment allowlist, applies the declared `env`, attaches writable state, materializes files, and runs requirements before the harness starts. Missing declarations fail boot; the host Home and undeclared credential variables cannot satisfy them.

`home.files` targets and state paths are relative POSIX paths below the materialized Home. A `from` source is relative to `cwd`, or the ViteHub process directory when `cwd` is omitted. Files with `contents` accept text, bytes, or a `BoxValue` callback. Every declared value is required.

The project may commit declarations, non-secret files, and ciphertext. Resolve plaintext through Server Env or another runtime capability. Do not commit plaintext credentials or the capability that decrypts committed ciphertext.

## Separate files from state

`home.files` is rebuilt at every boot and never becomes authoritative runtime state. Use it for `.gitconfig`, Codex configuration, arbitrary CLI settings, and immutable credential files.

`home.state` attaches an opaque writable directory from the runtime's protected `stateRoot`. Its `key` is a stable project-owned identity. The runtime resolves `seed` only when that state directory does not exist, so a refreshed OAuth file is never replaced by stale bootstrap data. Sessions sharing a state key are serialized until the owning session stops its processes and releases the lease.

A file may live beneath a state target. The runtime attaches state first and projects the file afterward, so committed configuration wins on every boot while adjacent CLI-owned files remain writable.

`trustedHost({ stateRoot })` requires a durable local path whenever state is declared. Keep it outside the checkout, workspace, build context, cache, and artifact directories. The runtime creates private children but does not change permissions on an existing caller-owned root.

## Use generic requirement checks

A string requirement checks that an executable exists on `PATH`. An object supplies a fixed command and argv after the Box is prepared, without parsing a project-supplied shell command:

```ts
requires: [
  "git",
  { name: "GitHub CLI", command: "gh", args: ["auth", "status"] },
  { name: "Acme CLI", command: "acme", args: ["auth", "status"] },
];
```

Core does not contain provider names or auth-file formats. `codexDriver()` contributes its own generic `codex login status` check when it uses direct OpenAI authentication.

Requirement names, commands, and argv are inspectable declaration metadata. Keep credentials in `env` or Home files rather than arguments.

## Run through Crabbox

```ts
import { crabbox } from "@vite-hub/box/crabbox"

box: {
  runtime: crabbox({
    profile: "babysitter",
    stateRoot: "/var/lib/vitehub/boxes",
  }),
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
      ".gitconfig": { from: ".vitehub/box/gitconfig" },
    },
  },
}
```

Crabbox materializes the same declaration on the target before requirement checks. Resolved material travels through Crabbox's protected stdin channel rather than command arguments. The private Home and writable state stay outside Workspace synchronization. An authoritative `cwd` is synchronized back; a disposable `checkout` remains target-local and is deleted with the Box session.

Crabbox requires either `cwd` or `checkout` and targets Linux/POSIX Static SSH hosts. `stateRoot` is an absolute path on the target. Static SSH does not support Crabbox port publishing; use `network: "direct"` only when the target shares the ViteHub process loopback namespace.

Commands must remain owned by their Box session. Daemonizing or escaping the session's process supervision is outside the v1 concurrency guarantee.

## Security boundary

A Box isolates Home, configuration, and declared process environment from ambient machine state. It does not isolate the filesystem, network, installed executables, or trusted project code. Use `trustedHost()` only when the Agent may act with the host user's authority, and use a real sandbox for untrusted code.

Resolved environment values, file contents, state, physical Home paths, and sandbox handles are excluded from serialized Box metadata. Requirement failures discard command output, while every process inside the Box remains trusted and can still read or log its credentials. Stable session identity uses declaration targets and state keys, never secret values or temporary paths.

Box `cwd` and `checkout` cannot be combined with Agent Workspace materialization because each owns the working tree. Omit both when the Agent should use a disposable Workspace session.
