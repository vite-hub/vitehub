---
title: Channel commands
description: Register Channel webhooks for a deployed stage, export a conversation, download Channel history, and replay it through an Agent.
navigation.title: Channels
navigation.order: 11
navigation.group: Commands
icon: i-lucide-messages-square
---

The `channels` and `conversations` commands register your Agent's webhooks with the provider and get its conversations back out. `hubAgent()` adds them.

## Synchronize Channel webhooks

Deploy the stage first, then compare its Channel webhooks with the provider. `channels sync` only reads by default, and `--json` gives a sanitized plan to review. Telegram is the first supported provider.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --json
```

The command checks that every webhook route is live at the exact public HTTPS origin, which defaults to `vitehub({ publicUrl })` when that is one string. `--stage staging` loads `.env.staging`, and process values win. Keep the Telegram bot token and webhook secret in Server Env, because the command takes no credential flags and never prints them.

To apply the plan, repeat the origin you typed in `--confirm-origin`, so nobody applies to the wrong deployment by accident. The configured `publicUrl` needs none, but a `--confirm-origin` you add anyway must match it.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --apply \
  --confirm-origin https://staging.example.com
```

| Flag | What it does |
| --- | --- |
| `--agent <name>`, `--channel <id>` | Narrow an app with many Agents. |
| `--allow-delete` | Allow removing a webhook, which the plan does when a Telegram Channel switches to polling or sets `webhooks: false`. The current provider URL must belong to the confirmed origin. |
| `--force` | Reapply when the URL matches but credentials or subscriptions changed. Telegram's `getWebhookInfo` does not return the secret token or allowed updates, so the plan marks them as unverifiable. |

Telegram accepts ports 443, 80, 88, and 8443, and the CLI rejects any other port before it applies. Pending updates are kept.

::note
`channels sync` only registers the webhook for message updates, the one event the built-in Channel supports. Admission rules, allowed users, secrets, and other update types stay in the app. An app-owned `adapter` is not synced, so an app with a custom adapter, certificate, fixed IP, or connection policy manages the provider itself.
::

## Export a Channel conversation

`conversations export` writes one conversation as Markdown or JSON from the dev server, or from the app at `--url` as [Call a deployed app](/docs/cli/operations#call-a-deployed-app) describes. It needs Console access to the `channels` section, not the webhook secret.

```bash [Terminal]
pnpm vitehub conversations export support telegram telegram:456 > chat.md
pnpm vitehub conversations export support telegram telegram:456 --format json --output ./chat --url https://app.example.com
```

Without `--output`, the text goes to stdout without attachments, and a retention warning goes to stderr. `--output` names a new directory that gets the file (`history.json` or `<thread>.md`) and the attachments in `media/`. `--media` and `--no-media` override the default. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).

When the app has the Channel operations, `channels list` lists Channels and their retention, `channels threads` lists a Channel's threads, and `channels conversation` reads one thread's messages in order. `channels status <agent> <channel>` shows the sync health and skipped messages of a [Gmail Channel](/docs/agents/gmail#failed-messages).

## Download Channel history

`channels history` downloads a deployed conversation and its attachments with the stage's webhook secret, into the same archive as `conversations export --format json --output`.

```bash [Terminal]
pnpm vitehub channels history \
  --stage production \
  --url https://app.example.com \
  --agent calories \
  --channel telegram \
  --output ./channel-history
```

| Flag | What it does |
| --- | --- |
| `--url <origin>` | The deployed origin. The default is `vitehub({ publicUrl })` when that is one string. |
| `--thread <id>` | The provider thread. A Telegram direct-message Channel finds it when the adapter allows exactly one user. Groups, and adapters that serve many conversations, issues, or tickets, need it. |
| `--webhook <id>` | The webhook registration, and its authentication, when a Channel declares several. |
| `--webhook-path <path>` | Export through another path on the confirmed origin, for example the built-in route of an older deployment that does not serve a declared `webhooks.path` yet. |
| `--query <key=value>` | Filter a Channel with `history`. Repeat it for several values. The export pages to the end. |
| `--invocations` | Join the kept Invocations and recorded deliveries to each item. |

Adapter-backed Channels export only the history the adapter or its State Adapter can give. Telegram cannot backfill, so it keeps the `threadHistory` window, 100 messages for seven days by default.

::tip
For a recovery archive of a Telegram Channel, export before that seven-day window ends.
::

A Channel with `history` exports its Collection items. With `--invocations`, each item has `invocations` with `id`, `status`, `createdAt`, `updatedAt`, `dryRun`, `label`, `deliveries: [{ channel, text }]`, and optional final `text`. Delivery text is the validated reply before app formatting, dry-run writes included, and keeping it needs Invocation content storage or `metadataContent` with `channel.effect.content`. The join matches `vitehub.channel.key` annotations, and [`history.invocationItem()`](/docs/agents/channels#replay-channel-history) joins older Invocations. The export never runs the Channel trigger or changes the journal.

## Replay Channel history

`channels replay` sends saved Channel history through an Agent again.

```bash [Terminal]
pnpm vitehub channels replay --agent support --channel mailbox --dry-run --label round-one --query folder=inbox
```

Each run is recorded with `triggeredBy: 'round-one'` and `vitehub.channel.key`. Repeat `--query key=value` for several values. A label has 1 to 512 characters and is not part of the history query, so filter a field named `label` with `--query label=value`.

Replay runs saved items through the Channel trigger without rechecking old provider signatures, while public webhooks still verify them. It needs the development project token, or Console authentication with `--url`, where the Agent must allow Console invocation. In `vite dev`, local dry runs need no Invocation setup in the app.
