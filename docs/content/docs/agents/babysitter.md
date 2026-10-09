---
title: Babysitter
description: Deploy an Agent that repairs pull requests, waits for checks, and merges ready ones.
navigation.group: Configure
---

The Babysitter preset repairs selected pull requests. It addresses review feedback from people and bots, fixes failing checks, and pushes the repair. Then it waits for check and review results without another model pass. It can also merge ready pull requests.

## Add the Agent

Select the preset in a discovered Agent. The repository filter is required: the Babysitter looks for open pull requests only in these repositories.

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/agent/presets/babysitter'

export default defineAgent({
  extends: babysitter,
  options: {
    filter: {
      repository: { allow: ['acme/app'] },
      author: { allow: ['octocat'] },
    },
    merge: 'direct',
    concurrency: 2,
  },
  driver: { model: 'gpt-5.6-sol' },
})
```

Add `instructions.md` next to `agent.ts` for project-specific guidance. It fills the preset's instruction slot.

| Option | Default | Purpose |
| --- | --- | --- |
| `filter` | `{}` | Pull requests to repair, with the [GitHub Channel filter rules](/docs/agents/channels). `repository.allow` is required. |
| `driver` | `'codex'` | `'codex'` or `'claude-code'`. Set the model and provider settings with the ordinary `driver` field. |
| `merge` | `false` | `false`, `'auto'` (request GitHub auto-merge), `'direct'` (merge a ready PR on the host), or `{ strategy: 'direct', method, ready }`. |
| `reviewChecks` | `[]` | Check names, such as a review bot's check, that keep a PR waiting while they run. |
| `noFindingsReviews` | `[]` | Body prefixes of comment-only reviews that report no findings, such as `'> ✅ No new issues found.'`. They do not wake a waiting PR. |
| `ignoreFeedbackAuthors` | `[]` | Logins, such as deployment preview bots, whose comments and reviews never need an assessment. They do not block a direct merge or wake a waiting PR. |
| `deferWhilePending` | `true` | Wait for running required checks and review checks before a pass, so one pass handles CI and review results together. A failure or a conflict starts the pass at once. |
| `noProgressBudget` | `3` | Passes on one head that can end without a push or a recorded wait. Then the PR waits until its head changes or a person comments. `false` disables the budget. |
| `install` | `true` | Install dependencies on the host before the model starts. `true` detects pnpm, npm or Yarn from the lockfile and installs it frozen; `{ command, args }` overrides it; `{ cache: { directory, entries } }` configures the pnpm cache; `false` skips it. |
| `mentionAllowlist` | `[]` | Exact GitHub logins the worker may notify through `mentionOnPullRequest`. The tool is reserved for verified blockers that need one person's action. |
| `concurrency` | `1` | Pull requests repaired at the same time. |
| `admission` | `{}` | Token budgets, a free-space guard and custom checks that stop model passes. See [Limit model passes](#limit-model-passes). |
| `capacity` | Process defaults | Host admission `memory`, `cpu`, and `fallbackConcurrency` settings. |

## Limit model passes

The host checks `admission` before it claims a pull request. A spent limit stops model passes. Direct merges and recorded waits continue, so a ready pull request still merges.

```ts [server/agents/babysitter/agent.ts]
export default defineAgent({
  extends: babysitter,
  options: {
    filter: { repository: { allow: ['acme/app'] } },
    admission: {
      inputTokens: { daily: 1_000_000_000 },
      paused: process.env.BABYSITTER_PAUSED === '1',
      async check() {
        const quota = await readProviderQuota()
        if (quota.usedPercent >= 80) return { reason: 'provider-quota', detail: `${quota.usedPercent}% of the weekly quota used` }
      },
    },
  },
})
```

| Field | Default | Purpose |
| --- | --- | --- |
| `inputTokens.hourly`, `inputTokens.daily` | No limit | Input tokens that the Agent's passes can use in the local clock hour and in the local day. Leave a window out for no limit. A pass continues when it goes past the limit; the next pass waits for the next window. |
| `minFreeTmpMb` | `4096` | Free space, in MiB, that the temporary directory needs before a pass. `false` disables the check. |
| `paused` | `false` | Stop every claim, including direct merges. Use it for a smoke boot or maintenance. |
| `check` | None | Extra check before each claim, for example a provider quota. Return `{ reason, detail, retryAt }` to stop model passes, or `undefined` to continue. When it throws, the error is shown in health and passes continue. |

The preset reads no token-budget or provider-quota environment variables and no provider status files. Applications that used `BABYSITTER_HOURLY_INPUT_TOKENS`, `BABYSITTER_DAILY_INPUT_TOKENS` or provider-specific quota guards must map them into these options and `admission.check`.

The health route shows the decision in `admission` and the token use, the limits and the `check` result in `budget`.

## Bound local verification

Start with one concurrent repair on a shared Linux host. Use `options.capacity.memory.perInvocationBytes` for each worker's growth budget and `reserveBytes` for memory that other services need. Use `serviceReserveBytes` for the reserve inside the process or cgroup budget (1 GiB by default); the host reserve is applied only to host memory. Linux admission checks host pressure and each visible cgroup ancestor, including a delegated service parent. It uses the least remaining cgroup memory headroom and observes ancestor pressure and high events. It does not read above a namespaced cgroup mount. An unreadable known cgroup uses the configured sample fallback. Admission reserves growth headroom for active workers. Set `options.capacity.fallbackConcurrency` to zero if a failed sample must pause admission.

A Babysitter Box uses the host-prepared PR checkout as its `cwd`. Configure its runtime, Home and requirements; the preset owns the working tree.

Admission only gates new work. Configure [Box memory limits](/docs/agents/boxes) to contain provider commands and native tools. The preset runs focused local tests and lint, then uses hosted CI for full typechecks and builds. A maintainer can require a bounded local reproduction. A memory-limit failure must lead to a smaller workload or a different budget before retrying.

## Share the Console journal

The Babysitter uses the invocation journal assigned to its discovered Agent. Set the Console journal in the ViteHub project configuration so the Console and the long-lived worker inspect the same records:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    console: {
      exposure: 'host-managed',
      authorize: './server/console-authorize.ts',
      databaseUrl: 'file:/var/lib/babysitter/console.sqlite',
    },
  })],
})
```

Create `server/console-authorize.ts` with your host session policy as shown in [host-managed Console access](/docs/development/console#protect-the-console-route). Every Console data route calls this function before it reads data.

The worker records and recovers Invocations under `<discovered-agent-name>-worker`, for example `babysitter-worker`. Each discovered Babysitter Agent has its own recovery scope. Other Agents can keep using the same journal without having their active Invocations failed. A standalone process host without an assigned journal keeps its private `dataDir/invocations.sqlite` file.


## Configure GitHub

Create a GitHub App with read and write access to contents, pull requests, issues, checks, and Actions. The Actions permission is required to rerun failed workflow jobs. Subscribe it to pull request, review, review comment, review thread, issue comment, check run, check suite, status, and push events. Set its webhook URL to `https://<host>/api/_vitehub/agents/babysitter/webhooks/github`.

Set these variables on the host, or declare them in `env.server.github`:

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | The App ID. |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` | The App private key. |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret. Deliveries without a valid signature are rejected. |
| `GITHUB_APP_INSTALLATION_ID` | Optional fixed installation. Requires `GITHUB_APP_OWNER`; it applies only to that owner. |
| `GITHUB_APP_OWNER` | Repository owner for the fixed installation, such as `vite-hub`. Server Env field `env.server.github.appOwner`. |
| `GITHUB_APP_INSTALLATIONS` | Optional JSON object mapping repository owners to installation IDs. Server Env field `env.server.github.appInstallations`. |
| `VITEHUB_AGENT_STATE_URL` | Agent State, for example `file:/var/lib/babysitter/state.sqlite`. Production builds require it. |

Declare the fixed ID as `env.server.github.appInstallationId` together with `appOwner`. Without an owner, the fixed ID is ignored. Owners without a configured installation use GitHub App discovery, which requires access to the App API.

The Babysitter commits as the App's bot. Workers call `commitRepair` with a message and explicit file paths because the provider sandbox protects Git metadata. GitHub tokens stay on the host; the worker reaches GitHub only through tools that are bound to its pull request. Host dependency installation uses the frozen lockfile before the provider starts. Invalid installation inputs wait durably without a timer retry. Correct the inputs, then push a new head or comment on the PR to resume. Installer capacity, filesystem, and package-manager failures retry after five minutes.

Host installation accepts HTTPS downloads from `registry.npmjs.org`, `registry.yarnpkg.com`, `pkg.pr.new`, `github.com`, and `codeload.github.com`. Local dependencies and workspace patterns must stay inside the checkout. Other registries, network protocols, and custom ports are rejected before the package manager runs. Use `install: false` with dependencies prepared in an isolated workspace when a repository needs other sources.

## Deploy

The Babysitter runs a long-lived process, so deploy it with the Node server preset on a host with a persistent disk, Git, and the provider CLI. The build fails with `AGENT_B0022` on Cloudflare, Vercel, Netlify, and Deno, and with `AGENT_B0023` without SQL Agent State.

ViteHub starts the Babysitter when the server starts. A development server starts it only with `VITEHUB_AGENT_PROCESS_HOSTS=1`, so it does not repair real pull requests by accident.

| Route | Purpose |
| --- | --- |
| `GET /api/_vitehub/host/health` | Health and the pull request queue: working, ready, and waiting. |
| `GET /api/_vitehub/host/drain` | Drain status: `accepting`, `draining`, or `drained`. |

To replace the process, send SIGUSR2, wait until the drain route reports `drained`, then restart. Running passes finish first.

## How it works

1. Signed webhooks update a durable pull request inbox in Agent State. Once a minute, one GraphQL query per repository lists the open pull requests; a pull request whose state changed without a delivery gets a targeted read, so lost deliveries are recovered within about a minute.
2. When a pull request needs work, the host clones its head and starts one repair pass with the Agent.
3. After a repair push, the pass ends within 3 minutes and the pull request waits on the pushed head.
4. Check results that the pass already knew, pending checks, and the push's own events keep it waiting. New feedback, a new failing check, a conflict, or an unresolved review thread wake it.
5. With `merge: 'direct'`, passing required checks also wake it. The host merges when every check passed, every review thread is resolved, and GitHub reports the pull request as clean on the default branch. It never merges into another branch.

Feedback that a pass assessed, or answered with a repair push, stays assessed on later heads. A later head needs a model pass only for new feedback, so a pull request whose push satisfied every finding merges without another pass. Bot issue comments count by identity, so a bot that edits its status comment does not cause a pass. Without required checks on the base branch, the newest run of every current-head check must finish before a merge. An earlier run of a rerun check is ignored.

A pull request that ends `noProgressBudget` passes on one head without progress waits until its head changes or a person comments. Stack parents are claimed before other work, and a restart releases the claims of the previous process. A stacked pull request whose parent merged into the default branch is moved to the default branch.

The host installs dependencies in each pass workspace before the model starts. The install gets only `PATH`, `HOME`, locale, package manager and `NODE_OPTIONS` variables, never the provider or GitHub credentials, and disables lifecycle scripts for detected installs. Custom install commands are trusted host configuration. The result is in `.git/vitehub-install.json` for the model.

On Linux, a detected pnpm install reuses the `node_modules` trees of an earlier pass with the same repository identity, lockfile, workspace file, package manifests, `.npmrc` files, patches and Node version. The host copies trees with independent writable inodes (using copy-on-write when supported), and verifies them with a frozen offline install; a failed check gets a clean install. Passes that need the same trees wait for the first install. It defaults to `BABYSITTER_INSTALL_CACHE` or `vitehub-install-cache` in the temporary directory, and keeps `BABYSITTER_INSTALL_CACHE_ENTRIES` or 8 entries. Set `install: { cache: false }` to disable it.

When the process temporary directory is inside the service's working directory, the host removes pass workspaces left by an earlier process at startup.

### Token admission estimates

`admission.inputTokens.hourly` and `admission.inputTokens.daily` are best-effort thresholds over retained Invocation journal usage, not hard host budgets or billing caps. Health reports identify this accounting as `best-effort-retained-journal`. The host samples at most once per minute and caches the largest input-token observation per Invocation, assigned to its latest update time. Active observations are included through the journal API. Concurrent writes during pagination can be missed until a later scan; retention and host restarts can omit usage permanently. The standalone journal retains 5,000 terminal records. Read errors appear in health diagnostics and do not block admission. Use provider-side spending limits when a hard cap is required.
