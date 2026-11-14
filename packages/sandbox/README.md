# @vite-hub/sandbox

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fsandbox&icon=npm)](https://npmx.dev/package/@vite-hub/sandbox)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fsandbox&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/sandbox)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/sandbox` owns portable execution for ViteHub. A project declares environment inputs, immutable Home files, writable Home state, and boot checks; a runtime Adapter turns that declaration into an inspectable preparation plan and opens active Sandbox sessions without exposing a provider SDK.

## Install

```sh
pnpm add @vite-hub/sandbox
```

## Prepare a trusted-host Sandbox

The Sandbox below reads two secrets of the app's Server Env:

```ts
// vite.config.ts
import { env, hubEnv } from "@vite-hub/env/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubEnv({
    server: {
      githubToken: env({ secret: true, source: env.source("GITHUB_TOKEN") }),
      codexAuthJson: env({ secret: true, source: env.source("CODEX_AUTH_JSON") }),
    },
  })],
});
```

```ts
import { resolveSandbox } from "@vite-hub/sandbox";
import { useServerEnv } from "@vite-hub/env";

const sandbox = await resolveSandbox({
  runtime: { kind: "trusted-host", stateRoot: "/var/lib/vitehub/sandboxes" },
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
      ".gitconfig": { from: ".vitehub/sandbox/gitconfig" },
      ".codex/config.toml": { from: ".vitehub/sandbox/codex.toml" },
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
import { resolveSandbox } from "@vite-hub/sandbox";

const sandbox = await resolveSandbox(
  {
    env: { PROJECT_ENV: "test" },
    requires: ["node", "pnpm"],
    runtime: "trusted-host",
  },
  {},
);

console.log(sandbox.plan.runtime, sandbox.plan.requirements, sandbox.plan.executionAuthority);

const session = await sandbox.open();
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

Spawned `vercel` processes stream `stdout` and `stderr` while they run. Consume both streams concurrently, or cancel unused output. Each channel buffers up to 1 MiB; if a log entry would exceed that limit, that stream errors with `SANDBOX_R0159` and discards its queued and subsequent output. The other channel continues streaming. Cancelling both channels stops log streaming without killing the process.

Spawned `cloudflare` processes stream `stdout` and `stderr` through `streamProcessLogs()` with the same 1 MiB per-channel limit and `SANDBOX_R0159` error. A custom `getSandbox` stub without `streamProcessLogs()` returns each channel's full output after the process exits. The built-in Durable Object starts each spawned command in its own process group with `setsid`, and `child.kill()`, a `timeout`, or an aborted `signal` signals that whole group, so child processes stop too.

For trusted-host processes, `child.kill()` sends `SIGTERM`, then sends `SIGKILL` after a 250 ms grace period if needed. On POSIX hosts it terminates the process group, including descendants. `child.kill(signal)` forwards the explicit signal and waits for the process to finish without automatic escalation.

A `timeout` or an aborted `signal` stops only that command, on every runtime. The Sandbox and its other processes keep running. `exec()` rejects with the abort reason. For `spawn()`, the runtime kills the process and `wait()` rejects with the abort reason.

`child.kill(signal)` sends the signal that you name, or rejects. The `vercel` runtime sends `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGKILL`, `SIGTERM`, `SIGCONT`, `SIGSTOP`, or a signal number. The `crabbox` runtime sends only `SIGTERM`. Other signals reject with `SANDBOX_R0165`.

A spawned `SandboxProcess` can also expose `stdin` as a `WritableStream<Uint8Array>`. The `trusted-host` and `crabbox` runtimes always forward it to the process. The `vercel` runtime forwards it only when you pass `stdin: true`, because a command that reads its input then waits until you close the writer. Close the writer to end the process input. Runtimes that cannot forward input leave `stdin` undefined:

```ts fragment
const child = await session.spawn!("node", ["workspace/filter.mjs"], { stdin: true });
const writer = child.stdin?.getWriter();
if (!writer) throw new Error("This Sandbox runtime does not forward process input.");
await writer.write(new TextEncoder().encode("input\n"));
await writer.close();
console.log(await new Response(child.stdout).text(), await child.wait());
```

Hosted runtimes use tagged values from the same root API:

```ts
import { resolveSandbox } from "@vite-hub/sandbox";
import type { CloudflareDurableObjectNamespace } from "@vite-hub/sandbox";

// `namespace` is the Durable Object binding of the Worker, such as `env.SANDBOX`.
export async function openHostedSandboxes(namespace: CloudflareDurableObjectNamespace) {
  const cloudflare = await resolveSandbox({
    runtime: { kind: "cloudflare", namespace },
  }, {});

  const vercel = await resolveSandbox({
    runtime: { kind: "vercel", ports: [3000] },
  }, {});
  return { cloudflare, vercel };
}
```

Use `runtime: "vercel"` for the default Vercel Sandbox configuration. Cloudflare remains tag-only because its Durable Objects namespace is required.

The Cloudflare runtime talks to the Sandbox Durable Object that the ViteHub Cloudflare host integration generates. That class starts the Container with the Workers Container API, uses `Files` from `@cloudflare/sandbox` 1.x, preserves Durable Object idle reuse, and the runtime bounds each transport operation with a deadline. It retries only operations that are safe to repeat, such as file reads and full file writes, when Cloudflare marks the error `retryable`. It retries a command or a new process only when the Container was not ready to receive it; other errors keep the Cloudflare flag in `error.data.retryable`. Pass `getSandbox` to use another Durable Object that implements `CloudflareSandboxStub`. Its `cancelExec(id)` must stop the `exec` command that was started with that `id`, and nothing else. The Vercel runtime exposes only the ports declared when the microVM is created. Both reject host `cwd`; materialize a Workspace into their working tree instead.

If Cloudflare Sandbox or Vercel cleanup fails, retry `session.close()`. The session rejects new operations after the first close attempt. Concurrent close calls wait for the same cleanup.

`sandbox.open({ initialize })` runs initialization inside runtime preparation. If initialization fails, a runtime must tear down the session and roll back state created for that failed boot.

`checkout` gives each invocation a disposable real Git repository at the exact requested commit. The runtime fetches `ref` from `remote`, verifies the resulting commit against the full `sha`, and starts the process in a detached checkout. Normal Git commits work, and callers can push explicitly with `git push origin HEAD:<branch>`. Use the source repository as `remote` for fork pull requests, and keep credentials in Sandbox `env` or Home rather than embedding them in the remote URL.

`checkout` and `cwd` are mutually exclusive. Use `cwd` for a caller-owned authoritative directory; use `checkout` when the Sandbox should create, isolate, and delete the working tree. Git is an implicit checkout requirement and is included in resolved Sandbox metadata.

Every Sandbox session receives a new private `HOME` plus `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME`. The runtime starts from a small operational environment allowlist, applies the declared `env`, attaches writable state, materializes files, and runs requirements before the process starts. Missing declarations fail boot; the host Home and undeclared credential variables cannot satisfy them.

`home.files` targets and state paths are relative POSIX paths below the materialized Home. A `from` source is relative to `cwd`, or the ViteHub process directory when `cwd` is omitted. Files with `contents` accept text, bytes, or a `SandboxValue` callback. Every declared value is required.

The project may commit declarations, non-secret files, and ciphertext. Resolve plaintext through Server Env or another runtime capability. Do not commit plaintext credentials or the capability that decrypts committed ciphertext.

## Separate files from state

`home.files` is rebuilt at every boot and never becomes authoritative runtime state. Use it for `.gitconfig`, Codex configuration, arbitrary CLI settings, and immutable credential files.

`home.state` attaches an opaque writable directory from the runtime's protected `stateRoot`. Its `key` is a stable project-owned identity. The runtime resolves `seed` only when that state directory does not exist, so a refreshed OAuth file is never replaced by stale bootstrap data. Sessions sharing a state key are serialized until the owning session stops its processes and releases the lease.

A file may live beneath a state target. The runtime attaches state first and projects the file afterward, so committed configuration wins on every boot while adjacent CLI-owned files remain writable.

`{ kind: "trusted-host", stateRoot }` requires a durable local path whenever state is declared. Keep it outside the checkout, workspace, build context, cache, and artifact directories. The runtime creates private children but does not change permissions on an existing caller-owned root.

## Use generic requirement checks

A string requirement checks that an executable exists on `PATH`. An object supplies a fixed command and argv after the Sandbox is prepared, without parsing a project-supplied shell command:

```ts
requires: [
  "git",
  { name: "GitHub CLI", command: "gh", args: ["auth", "status"] },
  { name: "Acme CLI", command: "acme", args: ["auth", "status"] },
];
```

Core does not contain provider names or auth-file formats. Declare every executable and authentication check required by the process that will run in the Sandbox.

Requirement names, commands, and argv are inspectable declaration metadata. They verify or select executables, but they do not restrict filesystem access, network egress, inherited credentials, or child processes. Inspect `sandbox.plan.executionAuthority` for those boundaries, and keep credentials in `env` or Home files rather than arguments.

## Provision the project toolchain

A Sandbox does not assume that Node.js, npm, pnpm, Yarn, or Corepack exist on the host or image. Declare `toolchain` and the Sandbox installs the versions that the project pins:

```ts fragment
const sandbox = await resolveSandbox({
  runtime: { kind: "trusted-host", stateRoot: "/var/lib/vitehub/sandboxes" },
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

If none matches, boot fails with `SANDBOX_R0147`. The Sandbox never falls back to a Node.js that happens to be on `PATH`. A range or alias such as `lts/*`, `lts/iron`, or `node` resolves to the highest matching release in the distribution `index.json`. The package manager comes from `package.json` `packageManager` (`pnpm@x.y.z`, `yarn@x.y.z`, or `npm@x.y.z`, with an optional `+sha512.<hex>` hash) or `devEngines.packageManager`. Without either, the project uses the npm bundled with Node.js. Bun fails with `SANDBOX_R0149`.

The ViteHub process downloads official archives with `fetch`. Node.js archives must match `SHASUMS256.txt` from the same distribution. Package managers come from the npm registry and must match its `dist.integrity` (sha512) and, when present, the `packageManager` hash. Yarn 2 and later use `@yarnpkg/cli-dist`; their `packageManager` hash is checked against its `bin/yarn.js`, as Corepack does. A project `yarnPath` still takes effect. ViteHub does not use Corepack, nvm, or mise. On musl Linux, Node.js comes from `https://unofficial-builds.nodejs.org/download/release`. Set `VITEHUB_NODE_DIST_URL`, `VITEHUB_NODE_MUSL_DIST_URL`, or `VITEHUB_NPM_REGISTRY_URL` in the ViteHub process to use a mirror.

The runtime provisions after it materializes the checkout and before requirement checks. It puts the package manager and Node.js `bin` directories first on the Sandbox `PATH`, adds `node` and the package manager to the requirements, and then checks `node -v` and `<package manager> --version` with the Sandbox environment. Without `checkout`, pins come from `cwd`, or the ViteHub process directory when `cwd` is omitted, and `sandbox.plan.toolchain` lists them. A `checkout` Sandbox reads them from the checkout at each boot, so its plan reports `source: "checkout"`. An open session reports the exact versions in `session.toolchain`.

| Runtime | Toolchain location |
| --- | --- |
| `trusted-host` | `<stateRoot>/toolchains`, or `$XDG_CACHE_HOME/vitehub/toolchains` without `stateRoot`. Shared by sessions and processes; a lock makes concurrent sessions download each version once. |
| `crabbox` | The same layout on the target, under the target user's cache when `stateRoot` is not set. Archives travel through the Crabbox copy transport. |
| `cloudflare`, `vercel` | `$HOME/.cache/vitehub/toolchains` in the Sandbox, for one session. An image `node` with the exact resolved version is used as is. |

Cache entries are content-addressed and read-only once published. Global installs such as `npm install -g` cannot write into them. To clear a cache, run `chmod -R u+w <cache> && rm -rf <cache>`. Installation uses `sh`, `tar` with gzip, `mktemp`, and `base64` on the target. The first boot of a version needs network access from the ViteHub process; an exact pin that is already cached boots without it. Custom runtimes do not provision toolchains, and boot fails with `SANDBOX_R0156` when one declares `toolchain`. Windows hosts are not supported.

## Run through Crabbox

```ts fragment
sandbox: {
  runtime: {
    kind: "crabbox",
    profile: "babysitter",
    stateRoot: "/var/lib/vitehub/sandboxes",
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
      ".gitconfig": { from: ".vitehub/sandbox/gitconfig" },
    },
  },
}
```

Crabbox materializes the same declaration on the target before requirement checks. Resolved material travels through Crabbox's protected stdin channel rather than command arguments. The private Home and writable state stay outside Workspace synchronization. An authoritative `cwd` is synchronized back; a disposable `checkout` remains target-local and is deleted with the Sandbox session.

Crabbox requires either `cwd` or `checkout` and targets Linux/POSIX Static SSH hosts. `stateRoot` is an absolute path on the target. File reads and writes use Crabbox's resolved SSH copy transport. Port URLs wait for and reuse one loopback-only Crabbox tunnel per port by default, and session teardown stops those tunnels. Use `network: "direct"` only when the target shares the ViteHub process loopback namespace.

Commands must remain owned by their Sandbox session. ViteHub adds the reserved `VITEHUB_SANDBOX_SESSION` environment marker to commands and reclaims marked processes on the SSH target when the session closes, including children adopted by supervisors. Commands cannot override this marker through the `env` option. Supervisors that launch replacement processes must preserve it.

The marker is read from each process's environment at launch. A process that starts with the marker remains owned by that Sandbox, even if it later changes its environment. A process started without the marker is not owned by that Sandbox, even if it references the Sandbox directory. This cleanup does not add process isolation.

## Run in a caged container

```ts fragment
sandbox: {
  runtime: {
    kind: "container",
    image: "node:24-bookworm",
    egress: { allow: ["registry.npmjs.org"] },
    credentials: {
      GH_TOKEN: { hosts: ["api.github.com", "github.com"], value: () => useServerEnv().githubToken.unseal() },
    },
    memoryBytes: 4 * 1024 ** 3,
  },
  checkout: { ref, remote, sha },
}
```

Each session starts a new container on an internal Docker network, through the Docker CLI of the ViteHub process. Without `egress`, the container has no network exit. With `egress: { allow }` or `egress: "open"`, a broker container (`mitmproxy/mitmproxy`, pinned) is the only exit. It refuses hosts outside the allowlist at `CONNECT` time and for each request. Credential hosts are always allowed.

The Docker daemon must be rootful Docker Engine 28 or newer on native Linux. The isolated bridge has no host address, and the Sandbox has no `NET_RAW` capability. This blocks direct access to host services with or without egress. Docker Desktop, OrbStack, WSL, and rootless Docker have additional host routes outside this boundary and are rejected before resources are created, as are older daemons. The CLI may use a remote native Linux daemon. Host patterns without a port allow only port 443; use `host:port` for another HTTP or HTTPS port. The broker rejects raw TCP tunnels.

Credential values resolve on the ViteHub host for each session and reach only the broker, through the Docker CLI environment. They are never on a command line. The Sandbox gets `vitehub-<NAME>-<random>` in each credential variable. The broker replaces it only in HTTPS request headers, including Basic authentication, to a host that the credential lists. A placeholder in a URL, over HTTP, to another host, or from an earlier session gets a `403` with a `SANDBOX_BROKER_B00x` code. The broker logs each request as a JSON line, without query strings. Read them with `docker logs`.

The Sandbox trusts the broker certificate through `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, and `REQUESTS_CA_BUNDLE`, and uses `HTTPS_PROXY`, `HTTP_PROXY`, and `NODE_USE_ENV_PROXY=1`. The CA private key stays in the broker. Home is `/vitehub/home` and the workspace is `/vitehub/workspace`. Relative file paths are relative to the workspace. `spawn` forwards input only with `stdin: true`. `kill()` signals the process group in the container. Closing the session removes both containers and the network. Each Docker object has the `dev.vitehub.sandbox` label, so `docker ps -a --filter label=dev.vitehub.sandbox` finds anything that a crashed process left.

The image needs `sh`, coreutils, GNU `find`, and `git` for a checkout. The runtime has no ports, no `cwd` mount, and no durable Home state. `cpus`, `memoryBytes`, and `pidsLimit` (default 4096) map to the `docker run` limits, and `user` runs commands as another image user. `docker` selects another Docker CLI.

## Bring a custom runtime

A `runtime` can also be an object with `name`, `prepare(input)` and `open(input, options)`. Set `network: "direct"` only when its sessions reach the ViteHub process loopback services, for example through SSH reverse tunnels. Agents then pass host Capability tools into the Sandbox. A session may implement `importWorkspace(checkout, signal)` and `refreshDependencies(checkout, signal)` to replace the generic working-tree copy and the publishing of host-installed dependencies. Use them when the runtime can transfer or install faster on its own host.

## Security boundary

A Sandbox isolates Home, configuration, and declared process environment from ambient machine state. It does not necessarily isolate the filesystem, network, installed executables, or trusted project code; the complete normalized provider declaration is `sandbox.plan.executionAuthority` and is copied unchanged onto every opened session. Dimensions the provider cannot establish remain `unknown`. Use `"trusted-host"` only when the Agent may act with the host user's authority, and use an isolated Sandbox runtime such as `vercel`, `cloudflare`, or `container` for untrusted code.

Resolved environment values, file contents, state keys, and physical Home paths are excluded from `sandbox.plan`; `sandbox.plan.home.state` lists declared target paths with opaque stable identities. Requirement failures discard command output, while every process inside the Sandbox remains trusted and can still read or log its credentials. Stable preparation identity uses declaration targets and state keys, never secret values or temporary paths.

Sandbox does not own Workspace snapshots, diffs, or commits. Workspace materializes those files through `SandboxSession.files`, while Sandbox remains responsible for execution and lifecycle.


## Trusted SSH command transport

`@vite-hub/sandbox/ssh` exports `sshLaunch` for Agent provider launch callbacks and `serveSsh` for a trusted sidecar. The client requires Node and OpenSSH. The server requires the optional `ssh2` peer.

```ts
import { sshLaunch } from "@vite-hub/sandbox/ssh"

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

A sidecar that is still starting refuses connections. `sshLaunch` connects again for up to `connectRetryMs` (30 seconds by default) while the SSH port refuses connections, so a provider probe or launch right after a pod restart waits for the sidecar. Authentication, host key, and command failures are not retried. Set `connectRetryMs: 0` to fail on the first refused connection.

The launch command includes a cancellable `prepare` callback. Agent Drivers await it before starting provider probe deadlines, for both Codex and Claude. It runs a separate `/bin/true` connection check; direct process consumers can await it before starting their own deadline. OpenSSH local diagnostics are kept separate from remote stderr so a command that starts another failing SSH client is never repeated.

The `vite-hub` distribution also exposes this module as `vite-hub/sandbox/ssh`, and `vitehub sandbox serve` and `vitehub sandbox check` run the server and a Driver readiness check without a project config. See the [CLI reference](https://vitehub.dev/docs/development/cli#commands).

This transport grants arbitrary command execution as the configured user. It is not a sandbox and does not synchronize Workspace files. Server shutdown closes connections and stops supervised process groups. `close({ drainTimeoutMs })` stops new connections at once and waits up to `drainTimeoutMs` for open connections to close before it ends them, so a stopping container can let running commands finish. `connections` counts the open connections. `vitehub sandbox serve --drain-timeout <ms>` uses this on SIGTERM and SIGINT.

## Sandbox Tasks

A Sandbox Task is one job that runs inside one Sandbox. `@vite-hub/sandbox/task` runs a discovered Sandbox Task Definition inside a provider-backed Sandbox. It owns discovery, package staging, typed invocation, timeouts, and result transport. The rest of this package owns the Sandbox: the execution environment and its isolation.

Most applications should install [`vite-hub`](https://vitehub.dev/docs/getting-started/installation) and import APIs such as `runSandboxTask` from `vite-hub/sandbox/task`. Import `@vite-hub/sandbox/task` directly when you are building a library, a custom Vite composition, or package-level tooling.

### Install

Install Sandbox, TypeScript, Vite, and the Sandbox provider used by your deployment. Sandbox Tasks read their Definitions with TypeScript at build time. This first run uses Vercel Sandbox:

```sh
pnpm add @vite-hub/sandbox typescript @vercel/sandbox vite
```

Sandbox Task requires Node.js 22.18 or newer. Vercel execution also requires a Vercel project with Sandbox access. At runtime, use the project's environment or set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

For Cloudflare, install `@cloudflare/sandbox` 1.x instead and use the ViteHub Cloudflare host integration so it can emit the required Container, Durable Object binding, migration, and Worker exports. Both providers run remote, potentially billed infrastructure; Sandbox does not include a local in-process provider.

### Run one Sandbox Task

Register discovery and select the provider in Vite:

```ts
// vite.config.ts
import { hubSandboxTask } from "@vite-hub/sandbox/task/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubSandboxTask({ provider: "vercel" })],
  build: {
    ssr: "src/server.ts",
  },
});
```

Create a package-backed Definition at `server/sandbox-tasks/release-notes/package.json`. The folder path supplies the name `release-notes`, and its manifest owns the timeout for each execution attempt:

```json
{
  "private": true,
  "type": "module",
  "vitehub": {
    "sandboxTask": {
      "timeout": 30000
    }
  }
}
```

```ts
// server/sandbox-tasks/release-notes/index.ts
interface ReleaseNotesPayload {
  notes?: string;
}

export default async function releaseNotes(payload: ReleaseNotesPayload = {}) {
  return { summary: payload.notes?.split("\n")[0] ?? "" };
}
```

Invoke the discovered name from server code. `runSandboxTask()` returns a native Web `Response` and infers its payload from the Definition. A registered handler with a required payload requires that argument at invocation; optional and zero-argument handlers can be invoked without it. The handler's context defaults to `{}` when omitted:

```ts
// src/server.ts
import { runSandboxTask } from "@vite-hub/sandbox/task";

const response = await runSandboxTask("release-notes", {
  notes: "ship it\nadd tests",
});

if (!response.ok) throw new Error(await response.text());

console.log(JSON.stringify(await response.json()));
```

Build through Vite so discovery and the runtime registry are generated, then run the server entry:

```sh
pnpm vite build
node dist/server.js
```

The process prints:

```json
{ "summary": "ship it" }
```

The Definition entrypoint does not import `@vite-hub/sandbox/task`. ViteHub calls its default function with `(payload, context)` and returns its awaited result.

### Provider and lifecycle limits

- Provider selection belongs to application or host configuration, not to a Definition. `hubSandboxTask({ provider: "vercel" })` and `hubSandboxTask({ provider: "cloudflare" })` are the direct-package forms. The `vite-hub` distribution can infer these from its Vercel and Cloudflare hosts.
- `vitehub.sandboxTask.timeout` must be a positive integer no greater than `2_147_483_647`. It bounds one execution attempt after provider startup, including package preparation, staging, and execution. Queueing, Sandbox startup, and retry delays can make the complete `runSandboxTask()` call take longer. An elapsed attempt timeout sends an internal abort signal to cancellable provider operations and returns a `SANDBOX_TASK_TIMEOUT` error in a non-2xx JSON response. On Vercel, the Sandbox session gets the task timeout plus 30 seconds, because its clock starts before Sandbox setup. ViteHub then ends the run at the task timeout, not the VM.
- Pass `signal` to `runSandboxTask()` when it belongs to a request or Agent Invocation. ViteHub forwards it to Sandbox startup and execution, cancels queued Cloudflare runs and retry backoff, and preserves the caller's abort reason. A Definition timeout remains the independent bound for each execution attempt.
- Vercel Sandbox sessions are closed in a `finally` block after success or failure. Cloudflare also creates and closes a unique Sandbox for each run unless you configure `sandboxId` or pass one to `runSandboxTask()`. Session cleanup failures return a non-2xx JSON response, even after a successful handler. So do Cloudflare invocation-file cleanup failures in a Sandbox that stays open after the run. A Sandbox that ViteHub closes after the run loses its files when it closes, so ViteHub does not delete them separately.
- An explicit Cloudflare `sandboxId` opts into a shared Sandbox identity. ViteHub deletes invocation-local files after each attempt, caches prepared projects by digest inside that Sandbox, and serializes runs with the same ID within one runtime isolate. Separate Worker isolates can still enter the Sandbox concurrently, so use external coordination when deployment-wide serialization is required. The provider normally leaves an explicitly named Sandbox for idle shutdown; setting `keepAlive: true` makes ViteHub close its session after the run.

When `resolveSandboxTaskRunner().run()` throws, its error cause retains the original provider diagnostic. If execution and cleanup both fail, the cause chain contains an `AggregateError` with both failures. The primary error code and message stay unchanged. JSON error responses omit causes.

### Security and isolation

A Sandbox Task Definition name and its typed arguments select work; they are not a permission boundary. Code inside the Sandbox can use whatever filesystem, environment, network, credentials, executables, and child-process authority the selected provider exposes.

Inspect that authority before execution when application policy depends on it:

```ts
import { resolveSandboxTaskRunner } from "@vite-hub/sandbox/task";

const runner = await resolveSandboxTaskRunner("release-notes");
console.log(runner.executionAuthority);
```

The descriptor reports the provider's complete `ExecutionAuthority`, including dimensions it cannot establish as `unknown`. Apply provider controls such as Vercel `networkPolicy`, keep secrets in server environment or provider configuration, and do not treat container execution alone as authorization for untrusted code.

Payloads, context, and results must be JSON-serializable. Nested `Blob` and `Uint8Array` values cross the Sandbox boundary through invocation-local binary files, and Node.js `Buffer` values retain their type.

### Package projects

ViteHub uses the package manifest's `packageManager`, then a lockfile at that package root, then npm. A matching `pnpm-workspace.yaml` moves preparation to the pnpm Workspace root and carries the transitive `workspace:*` dependency closure into the Sandbox while the entrypoint still runs from its package directory.

Package entrypoints are ESM projects. Keep `"type": "module"`, use explicit relative ESM imports for local `.ts` and `.mts` source, and depend on packages that expose runtime-ready JavaScript. ViteHub compiles reachable local TypeScript without bundling package dependencies or moving relative assets. It rejects CommonJS/CTS, local package aliases and self-references, imports that escape the selected package, and Workspace dependencies that expose TypeScript runtime entries.

Use `<path>.sandbox-task.ts` with `defineSandboxTask()` for a free-form Definition outside `server/sandbox-tasks`. Free-form Definitions use their nearest package project.

### Read more about Sandbox Tasks

- [Sandbox Task guide](https://vitehub.dev/docs/sandbox)
- [Sandbox execution and security model](https://vitehub.dev/docs/agents/sandboxes)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [ViteHub security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md)
