---
title: Forge Channels
description: Run an Agent on GitLab, Forgejo, and Codeberg pull requests, and set up env and webhooks for each forge.
navigation.order: 41
navigation.group: Channels
icon: i-lucide-git-pull-request
navigation.kind: Guides
---

`gitlab()` and `forgejo()` start an Agent from pull request events. A GitLab merge request counts as a pull request, and its `iid` is the number, also in nested groups.

These Channels work like [`github()`](/docs/agents/channels#reconcile-github-pull-requests) for filters, mentions, reconcile triggers, replies, commit statuses, and activity comments. `pullRequest.read(invocation)` returns the request. Its `provider` is `gitlab` or `forgejo`, and `instance` names the Forge instance.

## Add a Channel

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { forgejo, gitlab } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    gitlab: gitlab({
      pullRequest: { reconcile: { mentions: ['@review-bot'] } },
      activity: true,
    }),
    codeberg: forgejo({ pullRequest: true }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

`forgejo()` uses Codeberg by default. For self-managed GitLab or Forgejo, set `baseUrl` to the instance root. The Channel adds the API path.

Choose what starts a run:

- `pullRequest`: slash commands.
- `reconcile.mentions`: mentions.
- `reconcile.comments`: comments without a command.
- `reconcile.triggers`: filters and mentions per event. Comment events are `comment`, `review`, and `review_comment`.
- `reconcile: true`: the lifecycle events `opened`, `reopened`, `synchronize`, and `ready_for_review`.

Only GitLab sends `ready_for_review`. Forgejo has no draft-to-ready event, so `forgejo()` rejects it in `reconcile.events`.

`pullRequest.ci` is `'report'` (default) or `'wait'`, as on GitHub. See [Hosted CI](/docs/agents/channels#hosted-ci).

The final reply is a pull request comment. `pullRequest.reply: false` turns it off. Delivery effects can add reactions, edit the triggering comment, or report commit statuses. `statusContext` defaults to `ViteHub Agent`. `activity: true` keeps one comment with session links and status, owned by the authenticated account.

## Server Env

Explicit options win over Server Env. If Server Env does not declare a field, the Channel reads the Forge variable.

| Server Env field | Forge variable | Default or use |
| --- | --- | --- |
| `gitlab.baseUrl` | `VITEHUB_GITLAB_BASE_URL` | `https://gitlab.com` |
| `gitlab.token` | `VITEHUB_GITLAB_TOKEN` | Token for metadata and writes. |
| `gitlab.webhookSecret` | `VITEHUB_GITLAB_WEBHOOK_SECRET` | Required webhook secret. |
| `forgejo.baseUrl` | `VITEHUB_FORGEJO_BASE_URL` | `https://codeberg.org` |
| `forgejo.token` | `VITEHUB_FORGEJO_TOKEN` | Token for metadata and writes. |
| `forgejo.webhookSecret` | `VITEHUB_FORGEJO_WEBHOOK_SECRET` | Required webhook secret. |

The matching options are `baseUrl`, `token`, and `webhookSecret`. Each takes a runtime callback. Tokens and secrets also take a Server Env secret with `unseal()`.

## Webhook setup

Set `sync.repositories`, and the sync command creates or updates repository webhooks:

```ts fragment
channels: {
  gitlab: gitlab({
    sync: { repositories: ['platform/team/api'] },
    pullRequest: { reconcile: { mentions: ['@review-bot'] } },
  }),
  codeberg: forgejo({
    sync: { repositories: ['platform/api'] },
    pullRequest: { reconcile: { comments: true } },
  }),
}
```

GitLab paths can include nested groups. Each Channel uses its `baseUrl`, `token`, and `webhookSecret` options, then Server Env. Sync needs a token and webhook secret:

- GitLab: the `api` token scope and Maintainer access to each project.
- Forgejo and Codeberg: the `write:repository` token scope and admin access to each repository.

Deploy the webhook route first. Then run a dry run:

```bash [Terminal]
vitehub channels sync --stage <name> --url <https-origin> --channel <id>
```

Apply the plan after you check it:

```bash [Terminal]
vitehub channels sync --stage <name> --url <https-origin> --channel <id> --apply --confirm-origin <https-origin>
```

The plan shows the current and desired URL, and each repository's hook ID, events, and active state. It lists each create or update. Events follow the pull request and activity features you turn on. Forge event groups can also send related issue events, which the Channel ignores.

The plan never shows tokens or secrets. It lists `webhookSecret` as unverifiable, because Forges do not return it. `--force` resends the secret to existing hooks. Sync never deletes hooks and leaves hooks with other URLs alone. It fails if a repository has duplicate hooks at the desired URL, so remove them first.

Without `sync.repositories`, the plan shows the Channel with no change and an unverifiable entry that names the option. You can still add webhooks by hand. See [Channel Env and sync](/docs/agents/channels#channel-env) and [CLI channel synchronization](/docs/development/cli#synchronize-channel-webhooks) for deploy checks and origin confirmation.

For Forgejo, sync sets JSON payloads and handles its grouped event subscriptions. If GitLab auto-disabled a hook, re-enable it with a successful test request in GitLab before sync. Different deployed webhook URLs can manage hooks on the same repositories.

## Configure webhooks

To set up a webhook by hand, point it at the generated Agent Channel route. Use the same secret as `webhookSecret` or its Server Env field.

| Forge | Events to enable |
| --- | --- |
| GitLab | Comments, Merge request events |
| Forgejo or Codeberg | Pull Request, Pull Request Comment, Review |

GitLab sends its secret in `X-Gitlab-Token`. Forgejo signs the body. A wrong signature or token returns HTTP 401. A missing secret fails with `AGENT_R0946`, naming the option and env variable. Delivery IDs stop duplicate Invocations. Reconcile runs share the pull request concurrency limit, which defaults to one.

## Limits

- No `pullRequest.workspace` checkout, artifacts, or `authorAssociation` filters. Add a Workspace through the Agent's other Capabilities if needed.
- `webhookSecret: false` is not supported.
- GitLab has approvals, not reviews. An `APPROVE` effect approves the merge request and posts the review text as a separate note. A comment review posts a note. A request-changes review fails with `AGENT_R0946`.
- Forgejo has native reviews, but these Channels cannot reach its CI runs, jobs, or check reruns.
- Metadata reads are limited. Change the limits with `maxBodyLength`, `maxCommentBodyLength`, `maxComments`, and `maxFiles` on `pullRequest`. The context reports omitted items and missing metadata.
- After a restart, activity lookup scans the newest 500 comments.
