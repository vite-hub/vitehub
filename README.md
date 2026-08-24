# Babysitter

Babysitter is a [ViteHub](https://github.com/vite-hub/vitehub) agent that converges open pull requests across configured GitHub repositories in bounded repair passes. Every five minutes, it runs one globally bounded batch of coding agents and wakes a pull request only when its observed GitHub state changes.

## How it works

```mermaid
flowchart TD
    schedule["Every 5 minutes"] --> discover["Read open pull requests from GitHub"]
    discover --> unchanged{"Observed state unchanged?"}
    unchanged -- Yes --> skip
    skip --> schedule
    unchanged -- No --> checkout["Create a disposable exact-head checkout"]
    checkout --> agent["Start a coding agent, up to the configured global limit"]
    agent --> work["Codex (or Claude Code) uses Skills and your own instructions to work on the PR"]
    work --> outcome{"Outcome"}
    outcome -- Repaired --> review["Push one commit and request review"]
    review --> park["Record the observed pull request fingerprint"]
    outcome -- Waiting --> park
    outcome -- Ready --> merge["Merge and delete the source branch"]
    outcome -- Obsolete --> close["Close the pull request"]
    outcome -- External blocker --> block["Record the blocker"]
    block --> park
    park --> schedule
    merge --> schedule
    close --> schedule
```

1. **Prepare pull requests.** The [schedule](server/babysitter.schedule.ts), built with ViteHub's [Schedule primitive](https://vitehub.dev/docs/server-primitives/schedule), reads up to 100 open pull requests from each configured GitHub repository. Each selected pull request gets a disposable checkout verified against the observed head SHA, so one run cannot inspect one revision while editing another.
2. **Run pull requests in parallel.** One awaited worker pool applies a single concurrency limit across every repository and starts the next eligible pull request whenever an owner becomes free. ViteHub's process schedule runtime serializes schedule occurrences, so a later five-minute occurrence cannot overlap the active run. Each agent also receives a private [Box](https://vitehub.dev/docs/agents/boxes) Home containing only the declared GitHub and coding-agent credentials.
3. **Run one convergence pass.** The [agent prompt](server/agents/babysitter/prompt.template.md) and colocated [Skills](https://vitehub.dev/docs/capabilities/skills) tell the coding agent to inspect the exact head once. It either repairs every current actionable finding in at most one new commit, merges an already-ready head, closes obsolete work, records an external blocker, or yields pending checks and reviews. A repair pass pushes once, requests review once, and exits without polling for that review.
4. **Wake only when useful.** Every successful pass on an open pull request records its observed fingerprint in [ViteHub KV](https://vitehub.dev/docs/server-primitives/kv). Later schedules skip it until a commit, comment, check result, review, or metadata change updates that fingerprint. Failed, timed-out, or otherwise unfinished runs remain eligible for retry.

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

2. Install the dependencies and start Babysitter with repository names. `BABYSITTER_REPOS` accepts comma- or space-separated `OWNER/REPOSITORY` values. `BABYSITTER_MAX_OWNERS` caps the global batch and defaults to `1`, which is the safe starting point for an unmeasured host. The singular `BABYSITTER_REPO` remains supported and defaults to `vite-hub/vitehub` when the plural setting is empty.

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
   GITHUB_APP_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----' \
   pnpm dev
   ```

   To mirror invocation sessions and export completed OTLP traces to ViteHub Console, set its base URL and bearer token:

   ```sh
   VITEHUB_CONSOLE_URL=https://console.example \
   VITEHUB_CONSOLE_TOKEN=replace-me \
   pnpm dev
   ```

To use Claude Code instead, install `@ai-sdk/harness-claude-code`, then replace `codexDriver()` with `claudeCodeDriver()` in the [agent definition](server/agents/babysitter/agent.ts).

## Operational logs

Babysitter writes one-line JSON events prefixed with `[babysitter]`. A batch records its configured owner limit and backlog. Each owner records its repository, pull request, run ID, start time, outcome, and elapsed time. The ViteHub `diagnostics()` Capability samples resources every ten seconds and writes:

- one `agent.resource.snapshot` heartbeat per minute with process, host, and service-scoped cgroup observations;
- `agent.resource.peak` when a peak grows by at least 64 MiB;
- `agent.invocation.terminal` with the run ID, outcome, duration, and bounded nested failure details.

Linux cgroup and `/proc` fields are optional. Babysitter still runs on hosts that do not expose them. Service-scoped observations correlate pressure with a run; they do not claim per-invocation attribution when multiple owners share the process.

On a systemd host, follow the events with:

```sh
journalctl -u babysitter.service -f -o cat | rg '^\[babysitter\]'
```

Keep `BABYSITTER_MAX_OWNERS=1` until representative runs finish without OOM events, sustained swap growth, or low available memory. Raise it one owner at a time. The limit applies across every configured repository.
