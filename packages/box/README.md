# @vite-hub/box

`@vite-hub/box` owns portable execution for ViteHub. A project declares environment inputs, immutable Home files, writable Home state, and boot checks; a runtime Adapter turns that declaration into an inspectable preparation plan and opens active Box sessions without exposing a provider SDK.

## Install

```sh
pnpm add @vite-hub/box
```

## Prepare a trusted-host Box

```ts
import { defineAgent } from "@vite-hub/agent";
import { useServerEnv } from "#vitehub/env/server";

export default defineAgent<any, { ref: string; remote: string; sha: string }>({
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

Agent and Sandbox orchestration use the same active Interface under the hood. Direct callers can inspect preparation without resolving secrets, then open an invocation session:

```ts
import { resolveBox } from "@vite-hub/box";

const box = await resolveBox(
  {
    env: { PROJECT_ENV: "test" },
    requires: ["node", "pnpm"],
    runtime: "trusted-host",
  },
  {},
);

console.log(box.plan.runtime, box.plan.requirements, box.plan.executionAuthority);

const session = await box.open();
try {
  await session.files.write("workspace/input.bin", new Uint8Array([0, 1, 255]));
  const result = await session.exec("node", ["workspace/run.mjs"], {
    cwd: session.cwd,
    timeout: 30_000,
  });
  if (!result.ok) throw new Error(result.stderr);
} finally {
  await session.close();
}
```

Binary file reads and writes, directory operations, recursive listing, removal, and command execution are required across runtimes. Long-running processes and exposed ports are explicit optional capabilities through `session.spawn` and `session.ports`. `close()` is idempotent, and every operation rejects after closure.

Hosted runtimes use tagged values from the same root API:

```ts
const cloudflare = await resolveBox({
  runtime: { kind: "cloudflare", namespace: env.SANDBOX },
}, {});

const vercel = await resolveBox({
  runtime: { kind: "vercel", ports: [3000] },
}, {});
```

Use `runtime: "vercel"` for the default Vercel Sandbox configuration. Cloudflare remains tag-only because its Durable Objects namespace is required.

ASCII is selected through the same Box API. Install its optional control-plane SDK, then use either the default environment-backed selection or a tagged configuration:

```sh
pnpm add @vite-hub/box @asciidev/box-sdk ssh2
```

```ts
const ascii = await resolveBox(
  {
    runtime: "ascii",
    checkout: {
      ref: "refs/pull/123/head",
      remote: "https://github.com/acme/project.git",
      sha: "0123456789abcdef0123456789abcdef01234567",
    },
  },
  {},
);
```

`runtime: "ascii"` reads `BOX_API_KEY` and uses a two-hour disposable TTL, which leaves room for an hour-long Agent Invocation plus preparation and cleanup. Use `{ kind: "ascii", apiKey, baseUrl, ttlSeconds }` for explicit server configuration. ViteHub creates the machine without account secrets, authorizes a session-only SSH key, materializes Home and the exact Git commit through the shared Box path, and deletes the Box when the session closes. It does not use caller-owned SSH keys or introduce a separate remote-Box abstraction.

The Cloudflare runtime preserves Durable Object idle reuse and bounds transient transport operations with retries and deadlines. The Vercel runtime exposes only the ports declared when the microVM is created. Both reject host `cwd`; materialize a Workspace into their disposable working tree instead.

`box.open({ initialize })` runs initialization inside runtime preparation. If initialization fails, a runtime must tear down the session and roll back state created for that failed boot.

`checkout` gives each invocation a disposable real Git repository at the exact requested commit. The runtime fetches `ref` from `remote`, verifies the resulting commit against the full `sha`, and starts the harness in a detached checkout. Normal Git commits work, and callers can push explicitly with `git push origin HEAD:<branch>`. Use the source repository as `remote` for fork pull requests, and keep credentials in Box `env` or Home rather than embedding them in the remote URL.

`checkout` and `cwd` are mutually exclusive. Use `cwd` for a caller-owned authoritative directory; use `checkout` when the Box should create, isolate, and delete the working tree. Git is an implicit checkout requirement and is included in resolved Box metadata.

Every Box session receives a new private `HOME` plus `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME`. The runtime starts from a small operational environment allowlist, applies the declared `env`, attaches writable state, materializes files, and runs requirements before the harness starts. Missing declarations fail boot; the host Home and undeclared credential variables cannot satisfy them.

`home.files` targets and state paths are relative POSIX paths below the materialized Home. A `from` source is relative to `cwd`, or the ViteHub process directory when `cwd` is omitted. Files with `contents` accept text, bytes, or a `BoxValue` callback. Every declared value is required.

The project may commit declarations, non-secret files, and ciphertext. Resolve plaintext through Server Env or another runtime capability. Do not commit plaintext credentials or the capability that decrypts committed ciphertext.

## Separate files from state

`home.files` is rebuilt at every boot and never becomes authoritative runtime state. Use it for `.gitconfig`, Codex configuration, arbitrary CLI settings, and immutable credential files.

`home.state` attaches an opaque writable directory from the runtime's protected `stateRoot`. Its `key` is a stable project-owned identity. The runtime resolves `seed` only when that state directory does not exist, so a refreshed OAuth file is never replaced by stale bootstrap data. Sessions sharing a state key are serialized until the owning session stops its processes and releases the lease.

A file may live beneath a state target. The runtime attaches state first and projects the file afterward, so committed configuration wins on every boot while adjacent CLI-owned files remain writable.

`{ kind: "trusted-host", stateRoot }` requires a durable local path whenever state is declared. Keep it outside the checkout, workspace, build context, cache, and artifact directories. The runtime creates private children but does not change permissions on an existing caller-owned root.

## Use generic requirement checks

A string requirement checks that an executable exists on `PATH`. An object supplies a fixed command and argv after the Box is prepared, without parsing a project-supplied shell command:

```ts
requires: [
  "git",
  { name: "GitHub CLI", command: "gh", args: ["auth", "status"] },
  { name: "Acme CLI", command: "acme", args: ["auth", "status"] },
];
```

Core does not contain provider names or auth-file formats. The `"codex"` Agent Driver contributes its own generic `codex login status` check when it uses direct OpenAI authentication.

Requirement names, commands, and argv are inspectable declaration metadata. They verify or select executables, but they do not restrict filesystem access, network egress, inherited credentials, or child processes. Inspect `box.plan.executionAuthority` for those boundaries, and keep credentials in `env` or Home files rather than arguments.

## Run through Crabbox

```ts
box: {
  runtime: {
    kind: "crabbox",
    profile: "babysitter",
    stateRoot: "/var/lib/vitehub/boxes",
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
      ".gitconfig": { from: ".vitehub/box/gitconfig" },
    },
  },
}
```

Crabbox materializes the same declaration on the target before requirement checks. Resolved material travels through Crabbox's protected stdin channel rather than command arguments. The private Home and writable state stay outside Workspace synchronization. An authoritative `cwd` is synchronized back; a disposable `checkout` remains target-local and is deleted with the Box session.

Crabbox requires either `cwd` or `checkout` and targets Linux/POSIX Static SSH hosts. `stateRoot` is an absolute path on the target. File reads and writes use Crabbox's resolved SSH copy transport. Port URLs wait for and reuse one loopback-only Crabbox tunnel per port by default, and session teardown stops those tunnels. Use `network: "direct"` only when the target shares the ViteHub process loopback namespace.

Commands must remain owned by their Box session. Daemonizing or escaping the session's process supervision is outside the v1 concurrency guarantee.

## Security boundary

A Box isolates Home, configuration, and declared process environment from ambient machine state. It does not necessarily isolate the filesystem, network, installed executables, or trusted project code; the complete normalized provider declaration is `box.plan.executionAuthority` and is copied unchanged onto every opened session. Dimensions the provider cannot establish remain `unknown`. Use `"trusted-host"` only when the Agent may act with the host user's authority, and use a real sandbox for untrusted code.

Resolved environment values, file contents, state, and physical Home paths are excluded from `box.plan`. Requirement failures discard command output, while every process inside the Box remains trusted and can still read or log its credentials. Stable preparation identity uses declaration targets and state keys, never secret values or temporary paths.

Box does not own Workspace snapshots, diffs, or commits. Workspace materializes those files through `BoxSession.files`, while Box remains responsible for execution and lifecycle.
