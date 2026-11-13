# @vite-hub/presets

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fpresets&icon=npm)](https://npmx.dev/package/@vite-hub/presets)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fpresets&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/presets)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/presets` contains ready-made Agents that are built from ViteHub
primitives. Each preset is a subpath. The package depends on
[`@vite-hub/agent`](../agent/README.md); the Agent package does not know these presets.

Most applications use the `vite-hub/presets/*` imports of the `vite-hub` framework distribution.

| Import | Preset |
| --- | --- |
| `@vite-hub/presets/babysitter` | Repairs selected pull requests and merges them when the policy allows it. |
| `@vite-hub/presets/babysitter/server` | The Babysitter runtime for a custom process host. |
| `@vite-hub/presets/labeller` | Labels Gmail messages with ordered rules, then a constrained Jev choice. |
| `@vite-hub/presets/workspace` | Reads mounted Sources and cites files at their verified GitHub revision. |

## Primitives that the presets use

- `@vite-hub/agent/process`: `withAgentProcessHost()` attaches the Babysitter host.
  The `vitehub.agent` field of this package.json tells the Vite plugin which subpaths
  attach a process host or select a provider Driver.
- `@vite-hub/agent/channels`: `channelEnv()` and `channelEnvValue()` read the Server Env of a
  built-in Channel, and `channelMessageContextKey` reads the Channel message in `intercept`.
- `@vite-hub/agent`: the Babysitter worker builds its Agent from the configured one with
  `agentSettings()`, removes the host GitHub token with `withoutForgeAccess()`, and reaches the
  provider Sandbox with `activeProviderSandbox()`.

## Labeller

```ts
import { labeller } from "@vite-hub/presets/labeller"
```

See the [Labeller docs](https://vitehub.dev/docs/agents/labeller).

## Workspace preset

```ts
import workspace from "@vite-hub/presets/workspace"
```

See the [workspace preset docs](https://vitehub.dev/docs/agents/workspace-preset).

## Babysitter

Import `babysitter` from `@vite-hub/presets/babysitter`, or
`vite-hub/presets/babysitter` in an application. It repairs selected pull
requests, addresses human and bot review feedback, and parks while checks run.
Its workflow options are the GitHub Channel `filter`, lifecycle labels, the provider
`driver`, and the `merge` policy:

```ts
import { defineAgent } from "@vite-hub/agent"
import { babysitter } from "@vite-hub/presets/babysitter"

export default defineAgent({
  extends: babysitter,
  options: {
    filter: { repository: { allow: ["acme/app"] } },
    lifecycle: {
      labels: { require: ["agent:repair"], deny: ["agent:paused"] },
    },
    driver: "codex",
    merge: false,
    concurrency: 2,
  },
  driver: { model: "your-codex-model" },
})
```

`lifecycle.labels.require` admits a pull request when it has at least one listed
label. `lifecycle.labels.deny` pauses it whenever any listed label is present.
The same rules apply during discovery and to `opened`, `labeled`, and
`unlabeled` webhook events, so adding or removing a label can start, stop, or
resume work. Use `lifecycle.labels` for lifecycle control and `filter.labels`
for selection, rather than configuring both on one Babysitter.

With only `filter.repository.allow`, the Babysitter serves pull requests whose
author is an owner, member, or collaborator, skips those labelled
`babysitter:skip`, and merges ready ones directly. A direct merge holds a pull
request from someone without write access until a maintainer approves its head.
Any `filter.author` or `filter.authorAssociation` rule replaces the author
default, `lifecycle.labels` or `filter.labels` replace the label, and
`merge: false` turns merging off.

`filter.authorAssociation` selects authors by their GitHub `author_association`,
such as `{ allow: ["OWNER", "MEMBER", "COLLABORATOR"] }`. A pull request passes
when its author matches `filter.author.allow` or `filter.authorAssociation.allow`,
and a match on either deny list excludes it. Bots usually report `NONE`, so list
them in `filter.author`. Logins match without case and in either bot spelling,
so `renovate[bot]` also matches the GraphQL login `renovate`; this also applies
to `filter.actor` and `ignoreFeedbackAuthors`.

`driver` selects the provider Driver that repairs each checkout: `"codex"` (the
default) or `"claude-code"`. Set its model and other provider settings with the
ordinary `driver` field. Model and custom run Drivers cannot repair a checkout.

`install` defaults to `true`. This mode requires Git and Corepack in the trusted
host PATH. Install Corepack separately on Node 25 and newer. The package Node
engine does not install these host tools. The host installs dependencies from the
frozen pnpm, npm, or Yarn lockfile before starting the provider. Installers run one
at a time per host process to bound dependency setup memory. Lifecycle scripts and
repository package-manager hooks, plugins, and binary delegation stay disabled.
The package manager must name an official version, rather than a URL. Corepack
uses the trusted npm registry and ignores checkout environment files. npm must
be version 7 or newer. A manifest without a package-manager version uses a pinned
default rather than an ambient executable. Installation failures are recorded in
`.git/vitehub-install.json`. Invalid installation inputs park the PR until new head
or comment evidence wakes it. Host and package-manager failures retry after five
minutes. Set `install: false` for a checkout with no Node dependencies.
Dependency manifests and lockfiles are checked for local sources that escape the checkout, including encoded paths and symlinks. Project `.npmrc` and pnpm workspace configuration accept dependency declarations, peer and hoisting settings, and build allowlists. Other settings, including filesystem locations and package-manager extensions, are rejected before host installation. Supported configuration is fingerprinted so changes require a dependency refresh. npm accepts either `package-lock.json` or `npm-shrinkwrap.json`, and the boolean lockfile-shaping settings `legacy-peer-deps` and `install-links`.
Validation follows configured workspace patterns and referenced local packages; unrelated nested projects are excluded. pnpm workspaces without a root manifest use the pinned pnpm default. Executable fetch protocols such as Yarn `exec:`, Git dependencies that prepare remote projects, and unsupported source protocols are rejected before Corepack runs. Use registry packages or HTTPS archives instead, or set `install: false` when dependencies must be prepared in the provider sandbox.
Local package source files, archives, and patch files contribute their contents and executable mode to the dependency fingerprint. Local package source trees require regular files and directories; installed modules and Git metadata are excluded. Host installation reads a validated snapshot inside protected Git metadata, so provider writes cannot alter package-manager configuration or dependency sources after validation. The package-manager cache has its own CommonJS scope even in an ESM checkout. The host reconciles generated dependency outputs and rejects a refresh if the live dependency inputs changed. Workspace links continue to point to the live checkout.
Validation refreshes generated linked commands in reused input snapshots. A changed or deleted command requires a dependency refresh; tracked commands retain their commit snapshot.
Refresh reconciles all managed outputs. Switching to Yarn PnP removes obsolete root and workspace `node_modules`; switching away removes generated `.pnp.*` and Yarn cache state while preserving Yarn source configuration. Provider quota cooldowns pause model dispatch until their recorded deadline. Host merges and stack retargets continue during that cooldown.
Yarn `~/` patch selectors resolve from the project root after decoding. Other local patch selectors are rejected because Yarn can resolve them inside a parent package filesystem. Each grouped lockfile
descriptor is checked. Workspace glob matches must stay inside the checkout after
symlink resolution. Trusted GitHub release archives use the HTTPS archive path.
Workers call `commitRepair` with a message and explicit repair paths, then
`pushRepair`. The host commits because the provider sandbox protects Git metadata. For a
conflicting PR, the host first prepares a merge against the exact base commit.
Installation runs after merge preparation. The worker resolves dependency conflicts and calls `refreshDependencies` before validation, then commits through the same tool. Changing dependency inputs requires another refresh and validation before committing.
Unattended Codex runs preauthorize only the assigned host tools. Capability checks
still run on the host, and the native shell keeps its edit sandbox.

Direct merges use GitHub's asynchronous API, including native stacks. The inbox
records the request UUID and waits for GitHub to confirm a merge. Finished owners
release their queue lease while preserving any unresolved merge attempt. Expired
GitHub request results re-enter the current head's normal merge gates. An enqueued request retains its fence until the PR closes, merges, or changes head: queue absence and removal timeline commits do not identify the accepted request safely.

`merge` defaults to `false`:

| Value | Behavior |
| --- | --- |
| `false` | The Babysitter never merges. |
| `"auto"` | The worker may call `requestAutoMerge`, which requests GitHub native auto-merge. |
| `"direct"` | Before a model pass, the host squash-merges a PR that is ready. |
| `{ strategy: "direct", method, ready, markDraftsReady }` | Direct merge with `"squash"`, `"merge"`, or `"rebase"`, an optional `ready` hook, and optional draft authors. |

A direct merge needs passing required checks, completed and successful
current-head checks and statuses, loaded and resolved review threads, a
non-draft PR, and GitHub's live `mergeable_state: "clean"` on the default
branch. The merge request pins the head SHA, so a concurrent push makes GitHub
reject it. `ready({ repository, number, head, snapshot, requiredChecks })` can
add a policy, such as a required approval check; return `true` or a reason. Any
other result runs a normal repair pass. `ready: "approved-if-outside"` merges a
PR from an author without write access only after a reviewer with write access
approves its current head and no such reviewer's latest review requests changes.

A PR that is only `behind` a base requiring up-to-date branches, or whose base
changed its files after its checks ran, gets a branch update instead of a merge
or a model pass. A head that already contains the base tip needs no update. When
GitHub refuses `update-branch`, as it does for some stacked PRs, the host merges
the base into a same-repository head branch through `POST /repos/{owner}/{repo}/merges`
after checking that the head did not move.

`markDraftsReady` lists GitHub logins, such as maintainers and their bots, whose
drafts should merge. Off by default. When a pass has reviewed a draft's head, no
required check failed, and the head branch is in the repository itself, the host
marks the draft ready for review. The `ready_for_review` event wakes the PR and
starts workflows that skip drafts. A fork's draft and an unlisted author's draft
stay drafts.

After a repair push, the pass may continue for 3 minutes, then ends. The PR
waits on the pushed head. Later events on a waiting PR start a pass only when
they need one: new human or bot feedback, a new failing check, a merge conflict,
or an unresolved review thread. Pending checks, the pushed head's synchronize
event, and repeated results for failures the pass already saw keep it waiting.
With `merge: "direct"`, passing required checks also wake it, so the host can
merge. `reviewChecks` lists check names, such as a review bot's check, that keep
a PR waiting while they run. A comment-only review with an empty body does not
wake a waiting PR; its inline comments do. `noFindingsReviews` lists body
prefixes, such as `"> ✅ No new issues found."`, of comment-only reviews that
report no findings; these do not wake it either. `ignoreFeedbackAuthors` lists
logins, such as deployment preview bots, whose comments and reviews never need an
assessment. Feedback that a pass assessed or answered with a repair push stays
assessed on later heads, so a direct merge needs a model pass only for new
feedback. Bot issue comments count by identity, not body. Without required
checks on the base branch, the newest run of every current-head check must
finish before a merge.

`deferWhilePending` (default `true`) holds a pass while required checks or
review checks run, unless a failure or conflict already needs repair; the PR
wakes once the gates stop. `noProgressBudget` (default `3`, `false` disables it)
stops a head after that many passes without a push or a recorded wait, until the
head changes or a person comments. `reviewPushBudget` (default `3`, `false`
disables it) counts review-driven pushes on a PR: pushes from a pass without a
merge conflict and without a failing check outside `reviewChecks`. After that
many, bot feedback and failed `reviewChecks` no longer wake a model pass. A
person's feedback, another failing check, a conflict or a head that someone else
pushed still do. The PR then merges on its required checks or parks with the
reason, which health lists under `queue.parked`. `minorReviewRounds` (default
`false`) spends that budget once that many heads in a row had no automated
finding above P2; each pass reports the class in `automatedReview`.
`reviewConvergencePushes` (default `false`) asks each pass from that many
review-driven pushes on to fix a recurring finding class at its root.
`ignoreAssessedBotThreads` (default `false`) stops assessed bot-only review
threads from blocking a direct merge or waking the PR. `dailyPassBudget` (default
`16`, `false` disables it) limits the model passes per PR in a rolling 24
hours. A PR that reached it parks until its oldest pass is 24 hours old, and
health lists it with `resumeAt`. A person's new feedback, the first failing
required check on a head and a conflict on an otherwise ready PR still start a
pass. `install` (default `true`) installs
dependencies on the host before the model starts: it detects pnpm, npm or
Yarn from the lockfile and installs frozen, or runs `{ command, args }`. The
install gets a scrubbed environment and records its result and timing in
`.git/vitehub-install.json`. On Linux, a detected pnpm install reuses the
`node_modules` trees through independent copy-on-write copies. The default
cache directory is used only when its filesystem supports reflinks, because full
copies cost more than a frozen install from the pnpm store.
The cache is scoped by repository identity, lockfile, workspace configuration,
package manifests, `.npmrc` files, patches and Node version. Restored trees are
verified offline, with one install per cache key at a time. Detected installs
disable lifecycle and build scripts; custom commands are trusted host configuration.
`install: { cache: { directory, entries } }` configures the cache on any filesystem, and
`cache: false` disables it. At startup, the built-in host removes pass
workspaces from an earlier process when its temporary directory is inside the
service directory. Claims take reviewed heads first, then heads whose checks all
passed, then stack parents. A restart releases the claims of the previous process.
A stacked PR whose parent merged into the default branch is retargeted to the
default branch; until then the child waits. With `merge: "direct"`,
`repairStackChildren: true` (default `false`) repairs a child's checks, conflicts
and feedback alongside its open parent. The child never merges into the parent's
branch and waits for it once its reviewed head has nothing left to repair. A provider rate limit is retried three times; after that, model
dispatch waits for `providerCooldownMs` (five minutes by default), doubling per
consecutive cooldown up to an hour. The pass waits for the cooldown instead of
failing and spends no no-progress budget. `modelConcurrency` caps model passes.
Each owner rechecks the durable deadline before dispatch, including after
workspace setup. Host merges and stack retargets continue during the cooldown.
A failed dependency install continues the pass without dependencies unless
`install.required` is set; `install.concurrency` sets the install slots.
`warmWorkspaces` (default `false`) keeps one workspace per open PR in
`<dataDir>/pr-workspaces`. A pass on the head the previous pass pushed or left,
after a pass that finished, on a clean tree, keeps `node_modules` and build
caches and skips a current install; any other pass empties the workspace and
checks the head out again. The host clone is fetched instead of cloned. Entries
go when the PR closes, after `idleDays` (7) without a pass, and least recently
used first above `budgetGb` (60) or below `minFreePercent` (15) free disk.
`warmWorkspaces: { resumeThreads: true }` also continues the previous pass's
provider thread when that pass pushed or recorded a wait on the same base and
release.
While the built-in resource guard pauses model passes for a spent token budget, low temporary space or exhausted proxy accounts, host work continues. A token budget of `0` stops every claim.

Colocated `instructions.md` fills the preset's instruction slot without adding
headings. Explicit `driver.instructions` replaces that slot. Use
`{ mode: "replace", value: "..." }` to replace the complete instruction document.

A discovered Agent that imports the preset runs without more wiring on the Node
server preset. ViteHub generates a Nitro plugin that starts a process host for
it: a SQLite PR inbox in Agent State, bounded GitHub discovery of
`filter.repository.allow` (or, without it, of every repository the GitHub App
installations can access, except archived ones and `filter.repository.deny`),
claims, repair passes, and wake handling. Installing the App on a repository
enrolls it; `installation` and `installation_repositories` webhooks update the
list at once, and the host lists the installations again every 10 minutes. Signed
GitHub deliveries to `/api/_vitehub/agents/<name>/webhooks/github` feed the
inbox; they never start the Agent directly. `GET /api/_vitehub/host/drain`
reports drain status, and `GET /api/_vitehub/host/health` reports each host's
health and queue. SIGUSR2 starts a drain. The build fails with `AGENT_B0022` on
hosts that cannot keep a process running, and with `AGENT_B0023` without SQL
Agent State. Hosts start in production builds, or in development only with
`VITEHUB_AGENT_PROCESS_HOSTS=1`, so a development server does not repair real
PRs by accident.

The host reads the GitHub App from `env.server.github` or `VITEHUB_GITHUB_APP_ID`,
`VITEHUB_GITHUB_PRIVATE_KEY` (or `VITEHUB_GITHUB_PRIVATE_KEY_PATH`), and
`VITEHUB_GITHUB_WEBHOOK_SECRET`. It resolves the App installation of each repository and
commits as the App's bot. `VITEHUB_GITHUB_INSTALLATION_ID` pins the installation for
`VITEHUB_GITHUB_APP_OWNER`. `VITEHUB_GITHUB_APP_INSTALLATIONS` accepts a JSON object mapping owner
names to installation IDs. Other owners resolve their own installation. The host
ignores an environment installation ID without an owner.
A delivery without a configured webhook secret is rejected. Only the commit
author and committer identity pass to the worker; credentials do not. On its
first start, the host imports `.vitehub/pull-request-inbox.sqlite` from an
earlier hand-wired Babysitter once.

Pass results and their GitHub status deliveries commit in one inbox transaction.
The host publishes the saved result through its verified GitHub identity, retries
failed delivery after restart, and compares delivery versions before clearing an
entry. Delivery claims are atomic across hosts and expire after five minutes if
a host stops. Active writers renew their leases until publication settles, even
when the twenty-second deadline requests cancellation. Up to five publications
run outside queue reconciliation and remain tracked during process drain.
Deferred repair heads yield the bounded batch to other PRs. Saved results use
separate activity run IDs so completed invocations can publish their wait reason.
Older acknowledgements are backfilled with the corrected activity identity.
The inbox identifies its own activity by the host's immutable GitHub App ID.
An App rename cannot turn status updates into new repair feedback. Stored and
hydrated snapshots exclude those activity comments while retaining ordinary feedback.
New same-head feedback discards obsolete saved results. Confirmed repair-head and
closure transitions retain their result. If a writer settles after another host
replaces its expired lease, the latest settled result is requeued with a fresh
activity identity. A late saved-status write during an active worker queues a
running projection bound to that worker's claim. Its correction can publish
before the pass finishes, while an obsolete claim cannot authorize it.
GitHub comment writes cannot be fenced: a lease cannot
revoke an HTTP write already accepted by GitHub. A crashed writer's marker
expires fifteen minutes after its last delivery lease. Corrective replay stops
at that deadline. If an expired writer later settles in a live process, the host
queues the latest status again. An unobserved remote write after the deadline
can still overwrite the comment. Channels serialize activity publication by PR target before resolving credentials.
Separate token callbacks and token rotation cannot split that queue. Credential
resolution and read stages have thirty-second bounds. Caller cancellation can
shorten them, and a stalled credential or lookup callback releases the local queue
even when it ignores cancellation. An already-started write requests cancellation
at the deadline but retains target ordering and its durable delivery lease until
the actual transport settles. A custom transport that never settles after
cancellation can hold that target queue. Waiting comments
include the blocker reason. A confirmed repair result waits for its head webhook
if that webhook arrives after the pass finishes.

Known worker setup failures receive one recovery attempt per Agent `version` and
PR head. Bump an explicit version with each deployed Agent release. An Agent without
a version uses the installed package build identity, which changes with package
source and dependency updates even when preview builds reuse a manifest version.
Hosts that run package sources compute the same fingerprint at startup. The wake and release marker
commit together, so restarting the same release cannot repeat the wake. Timed
retries, check dependencies, and maintainer credential blockers keep their existing
wake conditions. Health can reuse admission accounting for at most two minutes
and reports its observation time; dispatch shares a fresh accounting read.

Invalid dependency installation inputs park the PR without a timer retry. Correct
the inputs, then push a new head or comment on the PR to resume. Installer capacity,
filesystem, and package-manager failures retain a five-minute retry.

Each pass uses a disposable provider workspace with unattended edit permission.
Native permission escalation is denied without prompting; the provider does not run
in full-access mode. GitHub tokens
stay on the host. Tools provide PR-bound log reads, repair pushes, comments,
metadata updates and thread resolution. Unless `merge` is `"auto"`, the worker
has no merge tool and the host rejects auto-merge operations. With `"auto"`, it
requests GitHub native auto-merge subject to current PR admission and repository
checks and reviews. Workers never merge directly or delete branches.

CI logs reach the worker without color codes or fetch branch listings, capped at
the last 4 MB of each failed job. Preloaded evidence and `readCheckLogs` return a
failure-focused excerpt; `readCheckLogs` also takes `tailLines` or
`startLine`/`endLine` for up to 1,000 lines the excerpt omitted.

Before a repair push, the host durably associates the exact candidate commit with
its active claim. Check and status webhooks for that commit are retained even when
they arrive before the source-push and synchronize webhooks. This association does
not count as a successful push and expires with the claim. A wait after several
repair pushes retains every verified push receipt, including when host admission
closes during a provider retry.
When a candidate becomes the PR head, earlier unpublished candidates stop accepting
CI evidence. Later pending candidates and separately verified push receipts remain valid.

A pass can resolve several addressed review threads without cancelling itself
when its own resolution webhooks arrive. New comments and external thread reopens
still revoke further repair operations.

## Babysitter GitHub host

`createGitHubHost()` from `@vite-hub/presets/babysitter/server` is the GitHub host that `createBabysitterRuntime()` takes. Use it to resolve GitHub App or fallback credentials, call GitHub through `@vite-hub/forge`, and run against an exact pull-request head in a temporary checkout. `withPullRequestCheckout()` uses Git over HTTPS, fetches the source branch directly, verifies the requested head, and removes the checkout contents after success, failure, cancellation, or timeout. Cleanup is best effort and preserves the callback result or error if filesystem discovery or deletion fails. Cleanup retains an empty temporary directory because removing its pathname could delete a concurrent replacement. Checkout and push operations need Git but do not need the GitHub CLI. Include `headRepository` and `headRef` to make an ordinary `git push` target the pull request's source branch. The callback keeps base repository access for reads from `origin`; use its `push()` after long-running work so the host resolves fresh source repository credentials before pushing. Push checks that the repair descends from the last verified head and uses a lease to reject a changed source branch. It returns the pushed SHA and advances the lease for later pushes in the same callback. Pass the Agent Invocation's abort signal and use the callback signal for work inside the checkout:

```ts fragment
await github.withPullRequestCheckout(pullRequest, async ({ env, path, push, signal }) => {
  await runAgent({ cwd: path, env, signal })
  await push()
}, { signal: invocation.abortSignal, timeout: 60_000 })
```

For a provider that materializes a separate working directory, call `checkout.prepareWorkspace(cwd)` from the provider launch hook, then `checkout.push(cwd)` from the host after reviewing the result. The host imports the exact commit without credentials and pushes it from the original trusted clone, so provider Git configuration cannot control the authenticated push. Preparation copies the independent PR clone's Git history and push destination, removes old target metadata and saved credential/header configuration, and leaves the original clone unchanged. These helpers apply only to prepared GitHub PR checkouts; other workspace types do not receive Git metadata. Keep host credentials out of the provider environment when push authority belongs to the host.

`access()` and `forge()` accept the same `signal` and `timeout` controls. Pass them whenever the operation belongs to an Agent Invocation so credential resolution and token refresh stop on cancellation. `forge({ repository })` returns a `forges` GitHub provider with that repository's credentials, with every Forge verb and `graphql()`. Create one for each operation, because installation tokens expire after one hour. Import `forges` errors such as `RateLimitedError` from `@vite-hub/forge`, so that `instanceof` matches the bundled classes. `rateLimit()` returns the most constrained GitHub rate limit that recent Forge responses reported, or undefined before the first response. Set `timeout` on `createGitHubHost()` to change the 60-second Forge request limit. The `credentials` callback receives the target `repository` and scoped `signal`. Select that repository's App installation in the callback and pass the signal to secret-manager or network requests. `host.channel()` also resolves credentials for each activity or delivery target repository. Unscoped `access()` calls omit `repository`, so the callback should supply its default credentials. `access({ minLifetime })` mints a new App installation token when the cached one expires within that many milliseconds. `host.channel()` passes it for Provider Driver runs. `access({ repository })` returns Git credentials for that repository only, in `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`. An unscoped `env` has `GH_TOKEN` but no Git credentials.

`host.channel({ activity: true })` is a github() Channel whose `app.token` comes from `host.access({ repository })`. It shares the host's credentials, login, and immutable App ID, and it gives its Agent forge access. App-owned activity keeps the original managed comment across App renames and process restarts. Each publication edits that comment once; historical duplicates are left alone.
A provider `env` resolver can call `host.environment()` inside
`withPullRequestCheckout()`. The environment binds to that callback's checkout,
including concurrent callbacks. Await the entire agent run before returning.
Use `defineAgent({ extends: agent, name, workspace })` to bind the workspace
without rebuilding driver configuration.
