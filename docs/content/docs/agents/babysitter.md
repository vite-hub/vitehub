---
title: Babysitter
description: Run an Agent that fixes your pull requests, waits for checks, and merges the ready ones.
navigation.group: Presets
navigation.order: 91
navigation.kind: Guides
---

The Babysitter preset (an Agent Definition that your Agent extends) fixes review feedback and failing checks on your pull requests, waits for new results without another model run, and can merge ready ones. One model run on a pull request is a *pass*.

## Minimal setup

Without options, the Babysitter repairs pull requests from people with write access to the repository, skips a pull request labelled `babysitter:skip`, and merges a ready one into the default branch. Name the repositories it serves:

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/presets/babysitter'

export default defineAgent({
  extends: babysitter,
  options: { filter: { repository: { allow: ['acme/app'] } } },
})
```

Then:

1. Turn on the Agent integration with the Node preset ([Enable the Agent integration](#enable-the-agent-integration)).
2. Create a GitHub App with read and write access to contents, pull requests, issues, checks, and Actions. Subscribe it to pull request, review, review comment, review thread, issue comment, check run, check suite, status, and push events, and set its webhook URL to `https://<host>/api/_vitehub/agents/babysitter/webhooks/github`. Install it on the repositories.
3. Set these variables on the host:

| Variable | Value |
| --- | --- |
| `VITEHUB_GITHUB_APP_ID` | The App ID. |
| `VITEHUB_GITHUB_PRIVATE_KEY` or `VITEHUB_GITHUB_PRIVATE_KEY_PATH` | The App private key, or the path of its PEM file. |
| `VITEHUB_GITHUB_WEBHOOK_SECRET` | The App's webhook secret. |
| `VITEHUB_AGENT_STATE_URL` | Agent State, such as `file:/var/lib/babysitter/state.sqlite`. |

4. Sign in the provider CLI on the host, such as `codex login` for the default `codex` driver ([Agent Drivers](/docs/agents/agent-drivers)).

When a GitHub variable is missing, the host does not start and logs `PRESETS_BABYSITTER_ENV_MISSING` with every missing name. It retries with backoff, so a fixed variable needs no restart. At startup, the host creates the labels that the filter names, such as `babysitter:skip`, in each repository that lacks them.

| Default | Change it with |
| --- | --- |
| Only authors whose `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` | Any `filter.author` or `filter.authorAssociation` rule replaces it. `filter.authorAssociation: {}` selects every author. |
| A pull request labelled `babysitter:skip` gets no work | `lifecycle.labels` or `filter.labels` replace it. `lifecycle: { labels: {} }` turns it off. |
| Ready pull requests merge directly, and a pull request from someone without write access waits for a maintainer's approval ([Gate outside contributors](#gate-outside-contributors)) | `merge: false` never merges. `merge: { strategy: 'direct', ready: () => true }` drops the approval gate. |

## Enable the Agent integration

Follow the [Agent setup](/docs/agents/get-started), then turn on the Agent integration with the Node host preset:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'node', agent: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: true })],
})
```
:::
::

The host needs Git, Corepack to install dependencies, and the authenticated CLI of your provider ([Agent Drivers](/docs/agents/agent-drivers)). Before production work, set up GitHub and persistent SQL Agent State, as shown below.

## Add the Agent

Extend the preset in `server/agents`. The repository filter is required, because the Babysitter looks for open pull requests only there.

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/presets/babysitter'

export default defineAgent({
  extends: babysitter,
  options: {
    filter: {
      repository: { allow: ['acme/app'] },
      author: { allow: ['octocat'] },
    },
    lifecycle: {
      labels: { require: ['agent:repair'], deny: ['agent:paused'] },
    },
    merge: 'direct',
    concurrency: 2,
  },
  driver: { model: 'gpt-5.6-sol' },
})
```

Add project guidance in `instructions.md` next to `agent.ts`. The preset puts it in its instruction slot.

The preset prompt already carries the generic repair rules: it classes findings from P0 (security hole, data loss, broken main path) to P3 (style), repairs automated reviewers' P0 and P1 findings and only small in-scope P2s, treats findings from people separately because a person does not re-review every push, fixes failing required checks before review findings, compares a failing check with the base before pushing, makes at most one repair commit per pass, and runs the repository's focused-test recipe. Keep `instructions.md` for what is specific to your project, such as the names of your review bots or a rule about screenshots.

| Option | Default | Purpose |
| --- | --- | --- |
| `filter` | `{}` | Pull requests to repair, with the [GitHub Channel filter rules](/docs/agents/channels). `repository.allow` is required. Without an `author` or `authorAssociation` rule, only authors with write access are selected. |
| `lifecycle` | `{}` | Label rules (`labels.require`, `labels.deny`) that decide which pull requests can get work. Without them or `filter.labels`, `babysitter:skip` pauses a pull request. |
| `driver` | `'codex'` | `'codex'` or `'claude-code'`. Set model and provider settings with the usual `driver` field. |
| `merge` | `'direct'` | `false`, `'auto'` (request GitHub auto-merge), `'direct'` (merge a ready PR on the host), or `{ strategy: 'direct', method, ready }`. `ready` is a callback or `'approved-if-outside'`, the default for a direct merge ([Gate outside contributors](#gate-outside-contributors)). |
| `reviewChecks` | `[]` | Check names, such as a review bot check. A PR waits while these run. |
| `noFindingsReviews` | `[]` | Body prefixes of comment-only reviews with no findings, such as `'> ✅ No new issues found.'`. They do not wake a waiting PR. |
| `ignoreFeedbackAuthors` | `[]` | Logins, such as preview bots, whose feedback needs no assessment, blocks no direct merge, and wakes no PR. |
| `deferWhilePending` | `true` | Wait for running checks on the head, even after a fast failure, so one pass handles CI and review together. A conflict starts the pass at once. A GitHub Actions check counts as stuck after 24 hours in the queue or 8 hours running. Other checks count as stuck after 30 minutes. |
| `noProgressBudget` | `3` | Passes on one head that can end without a push or a recorded wait. Then the PR waits for a new head or a person's comment. `false` turns it off. |
| `dailyPassBudget` | `16` | Model passes per PR in a rolling 24 hours. Then the PR parks until its oldest pass is 24 hours old ([Limit passes per pull request](#limit-passes-per-pull-request)). `false` turns it off. |
| `reviewPushBudget` | `3` | Review-driven pushes per PR. Then bot feedback and failed `reviewChecks` start no model pass ([Stop review ping-pong](#stop-review-ping-pong)). `false` turns it off. |
| `install` | `true` | Host install before the model starts. `true` runs a frozen pnpm, npm, or Yarn install from the lockfile. `{ command, args }` replaces the command, `{ cache: { directory, entries } }` sets the pnpm cache, `{ concurrency }` sets parallel installs (default `2`), `{ required: true }` parks the PR on failure (default `false`), and `{ refreshes }` limits `refreshDependencies` calls per pass (default no limit). `false` skips it. See [Dependency installation](#dependency-installation). |
| `ciRecovery` | `true` | Rerun failed GitHub Actions runs once before a model pass repairs them. |
| `repairStackChildren` | `false` | Repair a pull request whose base is another open pull request's branch alongside its parent, instead of waiting for the parent to merge. It never merges into the parent's branch. Requires `merge: 'direct'`. |
| `mentionAllowlist` | `[]` | Exact GitHub logins that the worker can notify with `mentionOnPullRequest`, only for verified blockers that need one person to act. |
| `concurrency` | `1` | Pull requests repaired at the same time. Host work, such as direct merges and stack retargets, also uses this limit. |
| `modelConcurrency` | `concurrency` | Model passes at the same time. Match what your provider accounts can serve. |
| `providerCooldownMs` | `300000` | First cooldown after a pass uses all its provider rate-limit retries ([Provider rate limits](#provider-rate-limits)). |
| `admission` | `{}` | Token budgets, a free-space check, and custom checks that stop model passes ([Limit model passes](#limit-model-passes)). |
| `capacity` | Process defaults | Host admission settings: `memory`, `cpu`, and `fallbackConcurrency`. |
| `placement` | None | Runs each pass on this host or in a Sandbox on another host ([Bound local verification](#bound-local-verification)). |

For a token or USD limit per pass, use the Agent's [`budget`](/docs/agents/capabilities/budget). `admission` is a host gate over time windows that can delay a new pass, based on journal usage. You can use both.

## Gate outside contributors

A direct merge uses `ready: 'approved-if-outside'` unless you pass another `ready`. The host then merges a pull request from someone without write access only after a maintainer approves it:

```ts fragment
merge: { strategy: 'direct', ready: 'approved-if-outside' },
```

- A pull request whose author's GitHub `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` merges as usual.
- Any other pull request waits until a reviewer with one of those associations approves its current head.
- Each reviewer's latest `APPROVED` or `CHANGES_REQUESTED` review counts. Comments and dismissed reviews leave it standing.
- A maintainer whose latest review requests changes blocks the merge, even when another maintainer approved.
- A push after the approval, including the Babysitter's own repair, needs a new approval.

The Babysitter still repairs the pull request while it waits.

For another policy, pass a function: `ready({ repository, number, head, snapshot, requiredChecks })` returns `true` or the reason the pull request waits. `ready: () => true` merges every ready pull request, including bot pull requests, whose author has no write access.

## Control work with labels

At startup, the host creates the configured labels in repositories that lack them. With the example above, add `agent:repair` to start work, add `agent:paused` to pause, and remove it to resume.

| Pull request labels | Eligible for work |
| --- | --- |
| `agent:repair` present, `agent:paused` absent | Yes |
| `agent:repair` absent | No |
| `agent:paused` present | No |

- `lifecycle.labels.require` needs at least one listed label. An empty or omitted list adds no requirement.
- `lifecycle.labels.deny` excludes a pull request with any listed label.
- The rules apply to discovery and to `opened`, `labeled`, and `unlabeled` webhook events.
- Removing a required label or adding a denied label also cancels the host's active claim on the pull request.

Use `lifecycle.labels` or `filter.labels`, not both: both is a configuration error. Labels only select pull requests. They do not report progress, allow a merge, or skip check and review gates.

## Limit model passes

`admission` stops model passes when a limit is spent. The host checks it before it claims a pull request. Direct merges and recorded waits continue, so a ready pull request still merges.

```ts [server/agents/babysitter/agent.ts] fragment
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
| `inputTokens.hourly`, `inputTokens.daily` | No limit | Input tokens for the Agent's passes in the local clock hour and local day. Leave a window out for no limit. A pass over the limit continues; the next pass waits for the next window. |
| `minFreeTmpMb` | `4096` | Free MiB that the temporary directory needs before a pass. `false` turns it off. |
| `paused` | `false` | Stop every claim, including direct merges, for a smoke boot or maintenance. |
| `check` | None | An extra check before each claim, such as a provider quota. Return `{ reason, detail, retryAt }` to stop model passes, or `undefined` to continue. If it throws, health shows the error and passes continue. |

The preset reads no token-budget or provider-quota environment variables or provider status files. Map old `BABYSITTER_HOURLY_INPUT_TOKENS`, `BABYSITTER_DAILY_INPUT_TOKENS`, or provider quota guards into these options and `admission.check`.

Health shows the decision in `admission`, and token use, limits, and the `check` result in `budget`.

## Provider rate limits

On a provider rate limit (HTTP 429), a pass retries three times, 10 seconds apart. Then the host starts a cooldown:

- Model passes stop until it ends. Host work continues: ready pull requests still merge directly and stacks still retarget. Pull requests that need a pass stay queued, unchanged.
- The pass that ran out of retries waits for the cooldown. It is not reported as failed and does not count against `noProgressBudget`, and neither does a pass cancelled after a rate limit.
- The first cooldown lasts `providerCooldownMs`. Each next one doubles, up to one hour, and halves the passes that can start, never below two. Passes that fail together count as one.
- A successful pass removes one step only when it ends at least 30 minutes after the last cooldown, so capacity comes back slowly.

A GitHub rate limit uses a separate breaker that stops every GitHub request of the host, including merges, for one hour.

## Bound local verification

On a shared Linux host, start with one repair at a time, then set `options.capacity.memory`:

- `perInvocationBytes`: how much each worker can grow.
- `reserveBytes`: memory that other services need, applied to host memory only.
- `serviceReserveBytes`: the reserve inside the process or cgroup budget. Default 1 GiB.

On Linux, admission checks pressure on the host and on each visible cgroup (a group of processes with shared resource limits) ancestor, including a delegated service parent. It uses the smallest remaining headroom, watches ancestor pressure and high events, and keeps growth headroom for active workers. It does not read above a namespaced cgroup mount. When it cannot read a known cgroup, it uses the configured sample fallback. Set `options.capacity.fallbackConcurrency` to zero to pause admission when a sample fails.

A Babysitter Sandbox uses the host-prepared pull request checkout as its `cwd`. You configure its runtime, Home, and requirements; the preset owns the working tree.

To add capacity beyond one host, set `options.placement`:

- `place({ repository, number })` runs before the host install and returns `{ sandbox?, release }`.
- A pass with a `sandbox` runs there and skips the host install, for example on a custom SSH runtime with `network: "direct"`. The Sandbox installs dependencies through its session's `refreshDependencies`.
- A pass without a `sandbox` runs on this host.
- `release()` runs once when the pass ends.
- An optional `remoteActive()` function next to `place` counts remote passes toward `concurrency`. They reserve no local memory.
- An optional `admitted()` function returns how many slots the hosts admit now, counting passes already running. Each reconcile then claims at most that many pull requests minus the active ones, so it does not claim work that `place` would turn away. Without it, claims follow `concurrency` alone.
- When no host can take a pass, throw `BabysitterPlacementCapacityError` from `place`. The pull request waits 30 seconds, or the error's `retryAfterMs`, and is claimed again. The wait does not count against its no-progress budget. Any other error from `place` fails the pass.

A configured `sandbox` always takes precedence over placement.

Admission only controls when new work starts. To contain provider commands and native tools, set [Sandbox memory limits](/docs/agents/sandboxes). The preset runs focused local tests and lint and leaves full typechecks and builds to hosted CI, unless a maintainer asks for a bounded local reproduction. After a memory-limit failure, shrink the workload or change the budget before you retry.

## Share the Agent journal

The Babysitter uses the invocation journal assigned to its discovered Agent. Set the location of the [default journal](/docs/agents/invocation-storage#use-the-default-journal) in the ViteHub project configuration, so the Console and the long-lived worker inspect the same records:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    agent: { invocations: { databaseUrl: 'file:/var/lib/babysitter/agent-invocations.sqlite' } },
    console: {
      authorize: './server/console-authorize.ts',
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    agent: { invocations: { databaseUrl: 'file:/var/lib/babysitter/agent-invocations.sqlite' } },
    console: {
      authorize: './server/console-authorize.ts',
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    agent: { invocations: { databaseUrl: 'file:/var/lib/babysitter/agent-invocations.sqlite' } },
    console: {
      authorize: './server/console-authorize.ts',
    },
  })],
})
```
:::
::

Create `server/console-authorize.ts` to decide which Console users and CLI keys may use the Babysitter sections, as [Limit a user to some sections](/docs/development/console#limit-a-user-to-some-sections) shows. Every Console call runs it before it reads data.

The worker records and recovers Invocations under `<discovered-agent-name>-worker`, such as `babysitter-worker`, so each Babysitter Agent has its own recovery scope. Other Agents can share the journal without their active Invocations failing. A standalone process host without an assigned journal keeps its own `dataDir/invocations.sqlite`.

## Configure GitHub

Create a GitHub App with read and write access to contents, pull requests, issues, checks, and Actions (to rerun failed workflow jobs). Subscribe it to pull request, review, review comment, review thread, issue comment, check run, check suite, status, and push events. Set its webhook URL to `https://<host>/api/_vitehub/agents/babysitter/webhooks/github`.

Set these variables on the host, or declare them in `env.server.github`:

| Variable | Purpose |
| --- | --- |
| `VITEHUB_GITHUB_APP_ID` | The App ID. |
| `VITEHUB_GITHUB_PRIVATE_KEY` or `VITEHUB_GITHUB_PRIVATE_KEY_PATH` | The App private key. |
| `VITEHUB_GITHUB_WEBHOOK_SECRET` | The webhook secret. The host rejects deliveries without a valid signature. |
| `VITEHUB_GITHUB_INSTALLATION_ID` | Optional fixed installation, only for `VITEHUB_GITHUB_APP_OWNER`, which it needs. |
| `VITEHUB_GITHUB_APP_OWNER` | Repository owner for the fixed installation, such as `vite-hub`. Server Env field `env.server.github.appOwner`. |
| `VITEHUB_GITHUB_APP_INSTALLATIONS` | Optional JSON object that maps repository owners to installation IDs. Server Env field `env.server.github.appInstallations`. |
| `VITEHUB_AGENT_STATE_URL` | Agent State, such as `file:/var/lib/babysitter/state.sqlite`. Production builds need it. |

Declare the fixed ID as `env.server.github.installationId` with `appOwner`; without an owner, ViteHub ignores it. Other owners use GitHub App discovery, which needs access to the App API.

The worker (the provider session of a pass) gets no GitHub tokens, only tools bound to its pull request:

- `readRepairState` shows the assigned head and base, the verified publication, the installation status, and whether the claim is valid. It does not query GitHub.
- `pushRepair` returns the verified published `head` with `pushed: true`.
- `readFeedback` reads a comment, review, or inline review comment from the PR's durable snapshot, by `kind` (`comment`, `review`, or `review-comment`) and `id`. Bodies come in pages of at most 16,000 JavaScript string characters; follow `next.offset` and `next.version` until `complete` is true. An edit invalidates the version, and a stale claim cannot read another head. In this release, the full feedback is also in the first context.
- `checkDependencies` lists the manifests, lockfiles, patches, and local dependency files that changed since the last host install, with `current: false` until `refreshDependencies` installs them again.
- `commitRepair` commits with a message and explicit file paths. Workers must use it because the provider sandbox protects Git metadata. Commits use the App's bot identity.
- `readCheckLogs` reads the failed jobs of a GitHub Actions run on the PR head, without color codes or fetch branch listings and capped at the last 4 MB of each job. By default it returns a failure-focused excerpt of at most 200,000 characters with its `includedLineRanges`. Pass `tailLines` for the end of the log or `startLine` and `endLine` for up to 1,000 complete lines. `readBaseCheckLogs` returns the same excerpt for a run on the exact base.

The host install before the provider starts ([Dependency installation](#dependency-installation)):

- accepts the pnpm workspace settings `peerDependencyRules`, `minimumReleaseAge`, and `minimumReleaseAgeExclude`, because they run no code
- accepts HTTPS downloads from `registry.npmjs.org`, `registry.yarnpkg.com`, `pkg.pr.new`, `github.com`, and `codeload.github.com`
- needs local dependencies and workspace patterns inside the checkout
- rejects other registries, network protocols, and custom ports before the package manager runs

For other sources, use `install: false` and prepare dependencies in an isolated workspace.

## Deploy

Deploy the long-running Babysitter with the Node server preset on a host with a persistent disk, Git, and the provider CLI. The build fails with `AGENT_B0022` on Cloudflare, Vercel, Netlify, and Deno, and with `AGENT_B0023` without SQL Agent State.

It starts with the server. A development server starts it only with `VITEHUB_AGENT_PROCESS_HOSTS=1`, so it does not repair real pull requests by accident.

| Route | Purpose |
| --- | --- |
| `GET /api/_vitehub/host/health` | Health and the pull request queue: working, ready, waiting, and `parked` (parked by a budget, with the reason). |
| `GET /api/_vitehub/host/drain` | Drain status: `accepting`, `draining`, or `drained`. |

To replace the process, send SIGUSR2, wait for the drain route to report `drained`, then restart. Running passes finish first.

SIGTERM, such as `systemctl restart`, does not wait for running passes. It stops new claims and gives the passes the shared [`agent.shutdown.drainMs`](/docs/agents/process-hosts#drain-agent-work-on-stop-signals) budget (default `0`) plus 15 seconds, then the process exits and the passes stop. Commits that a pass already pushed stay. The next process releases the stopped claims, removes their workspaces, and claims those pull requests again from their current head.

## How it works

1. Signed webhooks update a durable pull request inbox in Agent State. A one-minute GraphQL listing per repository finds changes without a webhook, so a lost delivery recovers in about a minute.
2. When a pull request needs work, the host clones its head and starts one repair pass.
3. After a repair push, the pass ends within 3 minutes and the pull request waits on the pushed head.
4. Known check results, pending checks, and its own push events keep it waiting. New feedback, a new failing check, a conflict, or an unresolved review thread wake it.
5. With `merge: 'direct'`, passing required checks also wake it. The host merges when every check passed, every review thread is resolved, and GitHub reports the pull request clean on the default branch. It never merges into another branch.

Assessed feedback stays assessed on later heads, so a pull request whose push fixed every finding merges without another pass. Bot issue comments count by identity, so a bot that edits its status comment causes no pass. When the base branch has no required checks, the newest run of every check on the current head must finish before a merge; earlier runs of a rerun check are ignored.

A wait is bound to the head that the pass saw: a new head clears it, and closing the pull request stops work. Wake conditions come from structured evidence about checks, reviews, the base, and mergeability, never the model's text. A wait does not allow a merge. The inbox is private; read it through the health route.

A restart releases the claims of the earlier process. When the parent of a stacked pull request merges into the default branch, the host retargets the child to the default branch. Until then the child waits for its parent. With `repairStackChildren: true`, the child gets passes for its own checks, conflicts and feedback in parallel, and waits for the parent once its reviewed head has nothing left to repair. The budgets in the options table also make a pull request wait.

The worker gets `npm_config_verify_deps_before_run=false`, so pnpm does not try to reinstall before each script over the host install, which ran without repository hooks. `driver.env` can override it. A pnpm lockfile that records a `pnpmfileChecksum` installs as is: the host drops the checksum only in its private install copy, because the hook does not run there.

The install in each pass workspace gets only the `PATH`, `HOME`, locale, package manager, and `NODE_OPTIONS` variables, never provider or GitHub credentials. Detected installs run without lifecycle scripts. Custom install commands are trusted host configuration. The model finds the result in `.git/vitehub-install.json`.

Two pull requests that change the same file can both pass checks and still break the base together. Before a direct merge, the host compares the changed files with files changed on the base since the checks ran. On overlap, or when the tested base is unknown, it updates the branch through GitHub and waits for checks on the new head instead. A head that already contains the base tip needs no update. A base that requires up-to-date branches gets the same update when the pull request is only behind it. When GitHub refuses the update, as it does for some stacked pull requests, the host merges the base into a head branch in the same repository through the merges API, after checking that the head did not move. Failed checks from an older base get one update and retest every six hours, when the current base tip has no failing check. Neither step starts a model pass.

The queue claims, in order: a pull request with a stored review on its current head, pull requests whose current-head checks all passed, stack parents, then the oldest work.

While GitHub still computes mergeability, the host rereads the pull request for a few seconds before it waits. A stored queue entry that fails validation is reported once as `babysitter.inbox.invalid_row` and skipped, so it cannot stop other work or the health route.

### Stop review ping-pong

A repair for one bot finding often gets new findings. `reviewPushBudget` (default `3`) ends that loop per pull request:

- A push is review-driven when its pass had no merge conflict and no failing check outside `reviewChecks`, judged from the GitHub state the pass claimed, not the model's report. A pass that pushes counts once.
- After the budget, bot comments, reviews, and review threads, and failures of `reviewChecks`, no longer wake the pull request.
- A person's comment or review, a failing check outside `reviewChecks`, a merge conflict, and a head someone else pushed still start a pass.
- With `merge: 'direct'`, the host merges when required checks pass, every review thread with a person's comment is resolved, and every comment from a person was assessed. Bot feedback and failed `reviewChecks` do not block it. GitHub branch rules still apply.
- Otherwise the pull request parks. Its result and GitHub status say why and what resumes it. Health lists it under `queue.parked` with `budget: "review-push-budget"`.

The count lasts for the life of the pull request, in its `reviewPushBudget` inbox record `{ count, heads }`, which the inbox summary also returns. `heads` lists heads the worker pushed and heads that had a pass after the budget was spent.

### Limit passes per pull request

`dailyPassBudget` (default `16`) limits model passes per pull request in a rolling 24 hours. Each pass counts once, when it starts. Host work, such as direct merges, CI reruns, and recorded waits, does not count.

When the budget is spent, the host parks the pull request before the next pass until the oldest pass is 24 hours old. The result and GitHub status name that time. Health lists it under `queue.parked` with `budget: "daily-pass-budget"` and `resumeAt`. New feedback before then starts no pass, except these, which also count:

- a person's comment or review that no pass saw yet
- the first failing required check on a head
- a merge conflict on a pull request with no failing check and no open review thread, once per head and base commit

The inbox stores the `dailyPassBudget` record `{ passes, human, exemptions }`, which the inbox summary also returns. `passes` holds the start time of each pass in the last 24 hours.

### Dependency installation

Detected installs share `install.concurrency` slots (two by default). A pass waits up to ten minutes for a slot and keeps its checkout meanwhile.

By default, installation is optional. On failure, the pass continues without dependencies, and `.git/vitehub-install.json` records `"status": "failed"` with the reason. The model then repairs the lockfile or manifests when they caused it, or relies on hosted CI and names the failure in its result. After a failed install, `commitRepair` does not check dependencies against the install. An unresolved dependency conflict in a prepared merge still needs `refreshDependencies` before validation.

`install: { refreshes }` limits `refreshDependencies` calls in one pass. A further call returns a tool error that tells the model to commit its dependency fixes and let hosted CI validate them; `commitRepair` then skips the local dependency check. A retryable install failure, such as a network error, does not count. A second call while an install runs waits for that install instead of starting another.

With `install: { required: true }`, a failed install parks the pull request:

- Invalid installation inputs wait durably with no timer retry. Fix them, then push a new head or comment to resume.
- Installer capacity, filesystem, and package-manager failures retry after five minutes.
- A lockfile that the frozen install rejects (such as `ERR_PNPM_OUTDATED_LOCKFILE`) gets one more pass on the same head, on this host without dependencies. The install error comes in a `<dependency-install-failure>` block, so the model can repair the lockfile.

On Linux, a detected pnpm install reuses `node_modules` trees of an earlier pass when the repository identity, lockfile, workspace file, package manifests, `.npmrc` files, patches, and Node version match:

- Trees are copied with independent writable inodes, copy-on-write when supported.
- A frozen offline install checks the copy; on failure, a clean install runs.
- Passes that need the same trees wait for the first install.
- The cache directory is `BABYSITTER_INSTALL_CACHE`, or `vitehub-install-cache` in the temporary directory. It keeps `BABYSITTER_INSTALL_CACHE_ENTRIES` entries, or 8.
- `install: { cache: false }` turns it off.

When the process temporary directory is inside the service working directory, the host removes pass workspaces and pass temporary directories left by an earlier process at startup.

### Health and prerequisites

Before model admission, the host checks for Git, and Corepack when it installs automatically. A missing tool shows in health with a `host-prerequisite` reason and an install action. Success is cached five minutes; failure retries after thirty seconds. Webhook intake and reconciliation stay available. A wait for installer capacity has the durable reason code `install-capacity` and uses no model repair attempt.

Health shows:

- runnable work in `queue.ready`, separate from retries in `queue.scheduled`
- `queue.oldestReadyAgeMs`, suppressed open PRs, and blocker counts, which can overlap (a timed wait can also wait for installer capacity)
- the application `release` and `framework.buildRevision` (a content fingerprint of the installed Agent build), which identify different code
- `admission.accepting`, the current state. `admission.history.lastSkip` and the compatibility field `admission.lastSkip` describe a past skip.

### Token admission estimates

`admission.inputTokens.hourly` and `admission.inputTokens.daily` are best-effort thresholds over usage kept in the Invocation journal, not hard host budgets or billing caps. Health calls this accounting `best-effort-retained-journal`.

- The host samples at most once per minute and caches each Invocation's largest input-token value at its latest update.
- The journal API includes active observations.
- A scan can miss concurrent writes during pagination until a later scan. Retention and host restarts can lose usage permanently.
- The standalone journal keeps 5,000 terminal records.
- Read errors show in health diagnostics and do not block admission.

For a hard cap, use provider-side spending limits.
