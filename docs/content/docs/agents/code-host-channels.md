---
title: Code Host Channels
description: Run an Agent on GitLab, Forgejo, and Codeberg pull request events.
navigation.order: 40.6
navigation.group: Connect
icon: i-lucide-git-pull-request
---

`gitlab()` and `forgejo()` connect pull requests to an Agent. GitLab merge requests use the same pull request context. The merge request `iid` is the pull request number, including projects in nested groups.

These Channels share filters, mentions, reconcile triggers, reply delivery, commit statuses, and managed activity comments with [`github()`](/docs/agents/channels#reconcile-github-pull-requests). Call `pullRequest.read(invocation)` to inspect the request. Its `provider` is `gitlab` or `forgejo`, and `instance` identifies the host.

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

`forgejo()` uses Codeberg by default. Set `baseUrl` to the instance root for self-managed GitLab or Forgejo. The Channel adds the API path.

Enable `pullRequest` to accept slash commands. Configure `reconcile.mentions` to accept mentions, `reconcile.comments` to accept comments without a command, or `reconcile.triggers` for event-specific filters and mentions. Comment trigger events are `comment`, `review`, and `review_comment`. Lifecycle events are `opened`, `reopened`, `synchronize`, and `ready_for_review`. `reconcile: true` enables these lifecycle events. Only GitLab reports `ready_for_review`. Forgejo sends no draft to ready event, so `forgejo()` does not accept it in `reconcile.events`.

The final reply is a pull request comment. Set `pullRequest.reply: false` to stop that reply. Delivery effects can add reactions, update the triggering comment, or report commit statuses. `statusContext` defaults to `ViteHub Agent`. `activity: true` keeps one managed comment with session links and status. The authenticated account owns that comment.

## Server Env

Explicit options take precedence over Server Env. The Channel reads the host variables when Server Env does not declare the field.

| Server Env field | Host variable | Default or use |
| --- | --- | --- |
| `gitlab.baseUrl` | `GITLAB_BASE_URL` | `https://gitlab.com` |
| `gitlab.token` | `GITLAB_TOKEN` | Token for metadata and writes. |
| `gitlab.webhookSecret` | `GITLAB_WEBHOOK_SECRET` | Required webhook secret. |
| `forgejo.baseUrl` | `FORGEJO_BASE_URL` | `https://codeberg.org` |
| `forgejo.token` | `FORGEJO_TOKEN` | Token for metadata and writes. |
| `forgejo.webhookSecret` | `FORGEJO_WEBHOOK_SECRET` | Required webhook secret. |

The matching options are `baseUrl`, `token`, and `webhookSecret`. Each accepts a runtime callback. Tokens and secrets also accept a Server Env secret value with `unseal()`.

## Webhook setup

Set `sync.repositories` to let the Channel sync command create or update repository webhooks:

```ts
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

GitLab paths can include nested groups. Each Channel uses its `baseUrl`, `token`, and `webhookSecret` options, then Server Env. Sync requires a token and webhook secret. GitLab needs the `api` token scope and Maintainer access to each project. Forgejo and Codeberg need the `write:repository` token scope and admin access to each repository.

Deploy the webhook route first. Inspect a dry run:

```bash [Terminal]
vitehub channels sync --stage <name> --url <https-origin> --channel <id>
```

Apply the reviewed plan:

```bash [Terminal]
vitehub channels sync --stage <name> --url <https-origin> --channel <id> --apply --confirm-origin <https-origin>
```

The plan shows the current and desired URL and each repository's hook ID, events, and active state. It lists each create or update. Events follow the enabled pull request and activity features. Host event groups can also deliver related issue events, which the Channel ignores.

Tokens and webhook secrets are never shown. The plan lists `webhookSecret` as unverifiable because hosts do not return it. Use `--force` to resend the secret to existing hooks. Sync never deletes hooks. It leaves hooks with other URLs unchanged and fails if a repository has duplicate hooks at the desired URL. Remove those duplicates before sync.

Without `sync.repositories`, the Channel appears in the plan with no change and an unverifiable entry that names the option. You can still set up webhooks by hand. See [Channel Env and sync](/docs/agents/channels#channel-env) and [CLI channel synchronization](/docs/development/cli#synchronize-channel-webhooks) for deployment checks and origin confirmation.

Sync manages JSON payloads for Forgejo hooks and accounts for its grouped event subscriptions. Auto-disabled GitLab hooks must be re-enabled with a successful test request in GitLab before sync can proceed. Distinct deployed webhook URLs can manage hooks on the same repositories.

## Configure webhooks

Create the project or repository webhook for the generated Agent Channel route. Set the secret to the same value as `webhookSecret` or its Server Env field.

| Host | Events to enable |
| --- | --- |
| GitLab | Comments, Merge request events |
| Forgejo or Codeberg | Pull Request, Pull Request Comment, Review |

GitLab sends its secret in `X-Gitlab-Token`. Forgejo signs the body. A wrong signature or token returns HTTP 401. A missing secret fails with `AGENT_R0946`, and the message names the option and env variable. Delivery IDs prevent duplicate Invocations. Reconcile runs use the shared pull request concurrency limit, which defaults to one.

## Limits

These Channels do not provide `pullRequest.workspace` checkout, artifacts, or `authorAssociation` filters. `webhookSecret: false` is not supported. Configure a Workspace through the Agent's other Capabilities if needed.

GitLab has approvals, not reviews. An `APPROVE` review effect approves the merge request and posts the review text as a separate note. A comment review posts a note. GitLab has no request changes review, so that effect fails with `AGENT_R0946`. Forgejo supports native reviews, but its CI runs, jobs, and check reruns are not available through these Channels.

Metadata reads have limits. Set `maxBodyLength`, `maxCommentBodyLength`, `maxComments`, and `maxFiles` on `pullRequest` to change them. The context reports omitted items and unavailable metadata. After a restart, activity lookup scans the newest 500 comments.
