# Babysitter

Babysitter is a [ViteHub](https://github.com/vite-hub/vitehub) agent that converges open pull requests across configured GitHub repositories in bounded repair passes. It discovers work on startup and through a 30-second repair scan. A shared adaptive capacity gate starts only the work that the host can support and keeps the rest as pending Agent Invocations.

## How it works

```mermaid
flowchart TD
    wake["Startup or repair scan"] --> discover["Read open pull requests from GitHub"]
    discover --> unchanged{"Observed state unchanged?"}
    unchanged -- Yes --> wait["Wait for the next wake"]
    unchanged -- No --> checkout["Create a disposable exact-head checkout"]
    checkout --> pending["Create a pending Agent Invocation"]
    pending --> capacity{"Host capacity available?"}
    capacity -- No --> pending
    capacity -- Yes --> agent["Start one coding agent"]
    agent --> work["Codex (or Claude Code) uses Skills and your own instructions to work on the PR"]
    work --> outcome{"Outcome"}
    outcome -- Repaired --> review["Push one commit and request review"]
    review --> park["Record the observed pull request fingerprint"]
    outcome -- Waiting --> park
    outcome -- Ready --> merge["Merge and delete the source branch"]
    outcome -- Obsolete --> close["Close the pull request"]
    outcome -- External blocker --> block["Record the blocker"]
    block --> park
    park --> wake
    merge --> wake
    close --> wake
```

1. **Discover changed pull requests.** The [demand reconciler](server/plugins/babysitter-demand.ts) reads up to 100 open pull requests from each configured GitHub repository. Wakeups coalesce while a scan is active. The 30-second scan repairs missed wakeups and new process startup always performs a fresh scan.
2. **Queue before admission.** Each selected pull request gets a disposable checkout verified against the observed head SHA, then creates a pending ViteHub Agent Invocation. One shared capacity object covers every repository and every checkout-specific Agent Definition. The queue is FIFO and bounded at 100 pending invocations.
3. **Adapt to the host.** `BABYSITTER_MAX_OWNERS` is the hard ceiling. On Linux, the process adapter reads cgroup memory limits, `memory.high` events, and 10-second CPU and memory PSI. It preserves 1 GiB of memory, estimates 1 GiB per additional owner, pauses admission above the pressure thresholds, resumes through lower thresholds, and adds at most one slot per sample. Hosts without readable cgroup signals use process-available memory. If sampling fails, admission falls back to one owner. Running owners are never preempted when pressure rises.
4. **Run one convergence pass.** The [agent prompt](server/agents/babysitter/prompt.template.md) and colocated [Skills](https://vitehub.dev/docs/capabilities/skills) tell the coding agent to inspect the exact head once. It either repairs every current actionable finding in at most one new commit, merges an already-ready head, closes obsolete work, records an external blocker, or yields pending checks and reviews. A repair pass pushes once, requests review once, and exits without polling for that review.
5. **Wake only when useful.** Every successful pass on an open pull request records its observed fingerprint in [ViteHub KV](https://vitehub.dev/docs/server-primitives/kv). Later reconciliations skip it until a commit, comment, check result, review, or metadata change updates that fingerprint. Failed, timed-out, or otherwise unfinished runs remain eligible for retry.

## Requirements

> [!WARNING]
> Babysitter uses your host and credentials to edit code, push branches, change pull requests, and merge them. Read the [agent prompt](server/agents/babysitter/prompt.template.md) before running it.

- Node.js 24 or newer
- Corepack, which activates Babysitter's pinned pnpm version
- `git` and a GitHub repository you want Babysitter to watch. Babysitter launches the owner in an exact-head checkout without installing the watched project's dependencies; adapt the [agent prompt](server/agents/babysitter/prompt.template.md) if the owner needs package-manager-specific setup.
- [`gh`](https://cli.github.com/) CLI. For production, configure a GitHub App with Contents, Issues, and Pull requests read/write access plus Actions, Checks, Commit statuses, and Metadata read access. Install it on every repository Babysitter watches. Local development can fall back to `GITHUB_TOKEN` or an authenticated `gh` CLI.
- An authenticated coding-agent CLI. ViteHub [Agent Drivers](https://vitehub.dev/docs/agents/agent-drivers) support both Codex and Claude Code. [Codex](https://github.com/openai/codex) is recommended because its non-interactive `codex exec` command is designed for programmatic use; this repository uses Codex by default.

## Start Babysitter

1. Read and adapt the [agent prompt](server/agents/babysitter/prompt.template.md) so its permissions, review policy, and merge rules match your repository.

2. Install the dependencies and start Babysitter with repository names. `BABYSITTER_REPOS` accepts comma- or space-separated `OWNER/REPOSITORY` values. `BABYSITTER_MAX_OWNERS` sets the global hard ceiling and defaults to `1`. Adaptive admission can run fewer owners, but never more. The singular `BABYSITTER_REPO` remains supported and defaults to `vite-hub/vitehub` when the plural setting is empty.

   ```sh
   corepack enable
   pnpm install
   BABYSITTER_REPOS=OWNER/REPOSITORY,OWNER/ANOTHER_REPOSITORY \
   pnpm dev
   ```

   A long-running Babysitter should use GitHub App credentials. The server mints renewable installation tokens and projects only the active token plus the `vitehub-bot[bot]` commit identity into each agent process:

   ```sh
   GITHUB_APP_ID=4698907 \
   GITHUB_APP_INSTALLATION_ID=156121915 \
   GITHUB_APP_OWNER=vite-hub \
   GITHUB_APP_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----' \
   pnpm dev
   ```

   Repositories outside `GITHUB_APP_OWNER` keep using `GITHUB_TOKEN` or the host's existing `gh` login, so one Babysitter can retain queues that span accounts.

   To mirror invocation sessions and export completed OTLP traces to ViteHub Console, set its base URL and bearer token:

   ```sh
   VITEHUB_CONSOLE_URL=https://console.example \
   VITEHUB_CONSOLE_TOKEN=replace-me \
   pnpm dev
   ```

To use Claude Code instead, install `@ai-sdk/harness-claude-code`, then replace `codexDriver()` with `claudeCodeDriver()` in the [agent definition](server/agents/babysitter/agent.ts).

## Operational logs

Babysitter writes one-line JSON events prefixed with `[babysitter]`. A reconciliation pass records its wake reason, configured hard ceiling, and discovered work. Each owner records its repository, pull request, run ID, outcome, and elapsed time, including queue delay. The ViteHub `diagnostics()` Capability samples resources every ten seconds and writes:

- one `agent.resource.snapshot` heartbeat per minute with process, host, and service-scoped cgroup observations;
- `agent.resource.peak` when a peak grows by at least 64 MiB;
- `agent.invocation.terminal` with the run ID, outcome, duration, and bounded nested failure details.

Linux cgroup and `/proc` fields are optional. Babysitter still runs on hosts that do not expose them. Service-scoped observations correlate pressure with a run; they do not claim per-invocation attribution when multiple owners share the process.

Before discovery, Babysitter checks the authenticated GitHub GraphQL budget and preserves a 1,500-point reserve. When the installation falls below that reserve, new GitHub work stays queued until the reported reset time instead of starting owners that are guaranteed to fail.

`GET /api/health` reports the hard ceiling, current effective concurrency, active and queued invocations, the latest admission reason, whether capacity sampling has degraded to its fallback, and whether GitHub budget pressure is deferring discovery.

On a systemd host, follow the events with:

```sh
journalctl -u babysitter.service -f -o cat | rg '^\[babysitter\]'
```

Have systemd send the non-terminating `SIGUSR2` drain signal before stopping the Node server, then poll the read-only drain status.

```ini
[Service]
WorkingDirectory=/srv/babysitter/current
ExecStop=/bin/sh .output/server/babysitter-drain $MAINPID http://127.0.0.1:3000/api/drain
TimeoutStopSec=70min
KillMode=control-group
```

`SIGUSR2` closes reconciliation admission before the signal handler returns. Repeated signals reuse the same drain. `GET /api/drain` reports `starting`, `accepting`, `draining`, `drained`, or `failed`. HTTP requests cannot start a drain, including requests forwarded by a local reverse proxy.

The production build copies the helper to `.output/server/babysitter-drain`, so deploy it with the rest of the immutable `.output` directory. The helper waits until the signal listener reports `accepting`, sends `SIGUSR2`, and blocks until both running and capacity-queued owner invocations finish. It fails immediately if the drain reports `failed` or the main process exits. Systemd then stops the server and clears any remaining processes in the service cgroup. Keep `KillMode=control-group`; `process` can leave owner children outside the service lifecycle. `TimeoutStopSec` bounds the agents' 60-minute invocation timeout plus queue and cleanup overhead.

Keep `BABYSITTER_MAX_OWNERS=1` until representative runs finish without OOM events, sustained swap growth, or low available memory. Raise the hard ceiling one owner at a time. The adaptive gate reduces admission under pressure; it does not prove that a higher ceiling is safe.
