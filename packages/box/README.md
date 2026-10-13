# @vite-hub/box

`@vite-hub/box` owns portable execution for ViteHub. A project declares environment inputs, immutable Home files, writable Home state, and boot checks; a runtime Adapter turns that declaration into an inspectable preparation plan and opens active Box sessions without exposing a provider SDK.

## Install

```sh
pnpm add @vite-hub/box
```

## Prepare a trusted-host Box

```ts
import { resolveBox } from "@vite-hub/box";
import { useServerEnv } from "#vitehub/env/server";

const box = await resolveBox({
  runtime: { kind: "trusted-host", stateRoot: "/var/lib/vitehub/boxes" },
  checkout: {
    ref: "refs/pull/985/head",
    remote: "https://github.com/vite-hub/vitehub.git",
    sha: "0123456789abcdef0123456789abcdef01234567",
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
}, {});
```

Direct callers can inspect preparation without resolving secrets, then open a session:

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

For trusted-host processes, `child.kill()` sends `SIGTERM`, then sends `SIGKILL` after a 250 ms grace period if needed. On POSIX hosts it terminates the process group, including descendants. `child.kill(signal)` forwards the explicit signal and waits for the process to finish without automatic escalation.

A spawned `BoxProcess` can also expose `stdin` as a `WritableStream<Uint8Array>`. The `trusted-host` and `crabbox` runtimes forward it to the process. Close the writer to end the process input. Runtimes that cannot forward input leave `stdin` undefined:

```ts
const child = await session.spawn!("node", ["workspace/filter.mjs"]);
const writer = child.stdin?.getWriter();
if (!writer) throw new Error("This Box runtime does not forward process input.");
await writer.write(new TextEncoder().encode("input\n"));
await writer.close();
console.log(await new Response(child.stdout).text(), await child.wait());
```

Hosted runtimes use tagged values from the same root API:

```ts
const cloudflare = await resolveBox({
  runtime: { kind: "cloudflare", namespace: env.SANDBOX },
}, {});

const computer = await resolveBox({
  runtime: { kind: "cloudflare-computer", namespace: env.AGENT, backend: "container-shell" },
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

The Cloudflare runtime uses `@cloudflare/sandbox`, preserves Durable Object idle reuse, and bounds transient transport operations with retries and deadlines. The preview `cloudflare-computer` runtime uses `@cloudflare/computer`: its Durable Object owns the authoritative filesystem while the selected Computer shell backend executes against it. Closing a Box clears ViteHub's managed roots and disposes Computer RPC handles without deleting the Durable Object or unrelated files. The Vercel runtime exposes only the ports declared when the microVM is created. All three reject host `cwd`; materialize a Workspace into their working tree instead.

If Cloudflare Sandbox or Vercel cleanup fails, retry `session.close()`. The session rejects new operations after the first close attempt. Concurrent close calls wait for the same cleanup.

`box.open({ initialize })` runs initialization inside runtime preparation. If initialization fails, a runtime must tear down the session and roll back state created for that failed boot.

`checkout` gives each invocation a disposable real Git repository at the exact requested commit. The runtime fetches `ref` from `remote`, verifies the resulting commit against the full `sha`, and starts the process in a detached checkout. Normal Git commits work, and callers can push explicitly with `git push origin HEAD:<branch>`. Use the source repository as `remote` for fork pull requests, and keep credentials in Box `env` or Home rather than embedding them in the remote URL.

`checkout` and `cwd` are mutually exclusive. Use `cwd` for a caller-owned authoritative directory; use `checkout` when the Box should create, isolate, and delete the working tree. Git is an implicit checkout requirement and is included in resolved Box metadata.

Every Box session receives a new private `HOME` plus `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME`. The runtime starts from a small operational environment allowlist, applies the declared `env`, attaches writable state, materializes files, and runs requirements before the process starts. Missing declarations fail boot; the host Home and undeclared credential variables cannot satisfy them.

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

Core does not contain provider names or auth-file formats. Declare every executable and authentication check required by the process that will run in the Box.

Requirement names, commands, and argv are inspectable declaration metadata. They verify or select executables, but they do not restrict filesystem access, network egress, inherited credentials, or child processes. Inspect `box.plan.executionAuthority` for those boundaries, and keep credentials in `env` or Home files rather than arguments.

## Provision the project toolchain

A Box does not assume that Node.js, npm, pnpm, Yarn, or Corepack exist on the host or image. Declare `toolchain` and the Box installs the versions that the project pins:

```ts
const box = await resolveBox({
  runtime: { kind: "trusted-host", stateRoot: "/var/lib/vitehub/boxes" },
  checkout: { ref, remote, sha },
  toolchain: "project",
}, {});
```

`"project"` is short for `{ node: "project", packageManager: "project" }`. The object form accepts:

| Option | Values |
| --- | --- |
| `node` | `"project"` (default), or a version, range, or alias such as `"22.11.0"`, `"22"`, `"^22.11.0"`, or `"lts/*"` |
| `packageManager` | `"project"` (default), `false` for the npm bundled with Node.js, or `name@version` such as `"pnpm@10.2.0"` |
| `fallbackNode` | A Node.js version, range, or alias used when the project pins none |

The first match selects Node.js:

1. `package.json` `devEngines.runtime`, the entry named `node` (object or array)
2. `.node-version`
3. `.nvmrc`
4. `package.json` `volta.node`
5. `package.json` `engines.node`
6. `toolchain.fallbackNode`

If none matches, boot fails with `BOX_R0147`. The Box never falls back to a Node.js that happens to be on `PATH`. A range or alias such as `lts/*`, `lts/iron`, or `node` resolves to the highest matching release in the distribution `index.json`. The package manager comes from `package.json` `packageManager` (`pnpm@x.y.z`, `yarn@x.y.z`, or `npm@x.y.z`, with an optional `+sha512.<hex>` hash) or `devEngines.packageManager`. Without either, the project uses the npm bundled with Node.js. Bun fails with `BOX_R0149`.

The ViteHub process downloads official archives with `fetch`. Node.js archives must match `SHASUMS256.txt` from the same distribution. Package managers come from the npm registry and must match its `dist.integrity` (sha512) and, when present, the `packageManager` hash. Yarn 2 and later use `@yarnpkg/cli-dist`; their `packageManager` hash is checked against its `bin/yarn.js`, as Corepack does. A project `yarnPath` still takes effect. ViteHub does not use Corepack, nvm, or mise. On musl Linux, Node.js comes from `https://unofficial-builds.nodejs.org/download/release`. Set `VITEHUB_NODE_DIST_URL`, `VITEHUB_NODE_MUSL_DIST_URL`, or `VITEHUB_NPM_REGISTRY_URL` in the ViteHub process to use a mirror.

The runtime provisions after it materializes the checkout and before requirement checks. It puts the package manager and Node.js `bin` directories first on the Box `PATH`, adds `node` and the package manager to the requirements, and then checks `node -v` and `<package manager> --version` with the Box environment. Without `checkout`, pins come from `cwd`, or the ViteHub process directory when `cwd` is omitted, and `box.plan.toolchain` lists them. A `checkout` Box reads them from the checkout at each boot, so its plan reports `source: "checkout"`. An open session reports the exact versions in `session.toolchain`.

| Runtime | Toolchain location |
| --- | --- |
| `trusted-host` | `<stateRoot>/toolchains`, or `$XDG_CACHE_HOME/vitehub/toolchains` without `stateRoot`. Shared by sessions and processes; a lock makes concurrent sessions download each version once. |
| `crabbox` | The same layout on the target, under the target user's cache when `stateRoot` is not set. Archives travel through the Crabbox copy transport. |
| `ascii`, `cloudflare`, `cloudflare-computer`, `vercel` | `$HOME/.cache/vitehub/toolchains` in the Box, for one session. An image `node` with the exact resolved version is used as is. |

Cache entries are content-addressed and read-only once published. Global installs such as `npm install -g` cannot write into them. To clear a cache, run `chmod -R u+w <cache> && rm -rf <cache>`. Installation uses `sh`, `tar` with gzip, `mktemp`, and `base64` on the target. The first boot of a version needs network access from the ViteHub process; an exact pin that is already cached boots without it. Custom runtimes do not provision toolchains, and boot fails with `BOX_R0156` when one declares `toolchain`. Windows hosts are not supported.

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

Commands must remain owned by their Box session. ViteHub adds the reserved `VITEHUB_BOX_SESSION` environment marker to commands and reclaims marked processes on the SSH target when the session closes, including children adopted by supervisors. Commands cannot override this marker through the `env` option. Supervisors that launch replacement processes must preserve it.

The marker is read from each process's environment at launch. A process that starts with the marker remains owned by that Box, even if it later changes its environment. A process started without the marker is not owned by that Box, even if it references the Box directory. This cleanup does not add process isolation.

## Security boundary

A Box isolates Home, configuration, and declared process environment from ambient machine state. It does not necessarily isolate the filesystem, network, installed executables, or trusted project code; the complete normalized provider declaration is `box.plan.executionAuthority` and is copied unchanged onto every opened session. Dimensions the provider cannot establish remain `unknown`. Use `"trusted-host"` only when the Agent may act with the host user's authority, and use a real sandbox for untrusted code.

Resolved environment values, file contents, state keys, and physical Home paths are excluded from `box.plan`; `box.plan.home.state` lists declared target paths with opaque stable identities. Requirement failures discard command output, while every process inside the Box remains trusted and can still read or log its credentials. Stable preparation identity uses declaration targets and state keys, never secret values or temporary paths.

Box does not own Workspace snapshots, diffs, or commits. Workspace materializes those files through `BoxSession.files`, while Box remains responsible for execution and lifecycle.


## Trusted SSH command transport

`@vite-hub/box/ssh` exports `sshLaunch` for Agent provider launch callbacks and `serveSsh` for a trusted sidecar. The client requires Node and OpenSSH. The server requires the optional `ssh2` peer.

```ts
import { sshLaunch } from "@vite-hub/box/ssh"

const launch = sshLaunch({
  host: "127.0.0.1",
  port: 2222,
  user: "agent",
  identityFile: "/ssh/id_ed25519",
  hostKeyFile: "/ssh/ssh_host_ed25519_key.pub",
})
// Pass launch to driver.launch in an Agent Definition.
```

The target must expose the same working-directory and credential paths, for example through a shared sidecar volume. Host keys are verified. Environment names come from the resolved provider launch context; values travel through SSH environment requests. An explicit `forwardEnvironment` narrows the list while retaining framework-required names. `serveSsh` accepts valid environment names from authenticated clients unless `acceptEnvironment` restricts them.

The `vite-hub` distribution also exposes this module as `vite-hub/box/ssh`, and `vitehub box serve` and `vitehub box check` run the server and a Driver readiness check without a project config. See the [CLI reference](https://vitehub.dev/docs/development/cli#commands).

This transport grants arbitrary command execution as the configured user. It is not a sandbox and does not synchronize Workspace files. Server shutdown closes connections and stops supervised process groups.

## Limit trusted-host command memory

On Linux, set `runtime.resources` to cap the combined memory of one session's commands and their descendants:

```ts
runtime: {
  kind: "trusted-host",
  resources: {
    cgroupParent: "/sys/fs/cgroup/system.slice/agent.service",
    memoryHighBytes: 3 * 1024 ** 3,
    memoryMaxBytes: 4 * 1024 ** 3,
    memorySwapMaxBytes: 128 * 1024 ** 2,
  },
}
```

Use a writable delegated cgroup v2 parent with the memory controller. For systemd 254 or later, `Delegate=memory` and `DelegateSubgroup=controller` place the controller in a separate child. `ProtectControlGroups` must allow the delegated subtree to be written. The parent must contain no processes before Box enables the controller. Box fails closed when configured limits cannot be enforced. Swap defaults to zero.

All `exec` and `spawn` commands in the session share one budget, including native provider tools. A local OOM kills the whole command group and rejects pending waits with `BOX_R0158`, the memory limit, peak bytes and OOM kill count. Further commands fail until a new session opens. Closing the session kills remaining descendants, including processes that left their process group, and removes its cgroup. `box.plan.resources` exposes the configured limits.

Checkout materialization, toolchain provisioning and requirement checks run before session commands and remain under the controller's service limits. The trusted launcher also prepares its environment under that budget, then joins the session cgroup before executing the command or any caller-controlled loader hooks. Keep those limits in place. This resource policy does not add filesystem or network isolation. Trusted commands can use the host user's authority to change cgroup membership; use a real sandbox for untrusted code.

On kernels without `memory.peak`, the OOM diagnostic reports `peak=unavailable`. Box invalidates the session on a local allocation OOM, including allocation failures without a kill. This signal identifies exhaustion of the session budget and works with `memory_localevents` mounts. Ancestor or host kills alone do not invalidate it. The diagnostic reports the observed `memory.events` kill count as context, not proof of the kill cause; that count can exclude descendant victims on `memory_localevents` mounts. Box removes nested cgroups during close. The launcher restores the command environment only after joining the session group.

If descendants remain alive after a kill, close waits up to 10 seconds for the cgroup to become empty. A timeout rejects close and retains the cgroup and state lease. Retry close after the descendants exit; cleanup must succeed before that state can be reused.
