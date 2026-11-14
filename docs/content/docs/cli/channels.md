---
title: Channel commands
description: Register Channel webhooks for a deployed stage, export a conversation, download Channel history, and replay it through an Agent.
navigation.title: Channels
navigation.order: 11
navigation.group: Commands
icon: i-lucide-messages-square
---

The Agent package adds the `channels` and `conversations` namespaces when `hubAgent()` is active.

## Synchronize Channel webhooks

Deploy the stage before you register its Channel webhooks. `channels sync` loads the Agent Definitions for the Vite stage, checks that every webhook route is live at the exact public HTTPS origin, and compares the provider state. Telegram is the first supported provider.

The command only reads by default. Use `--json` to get a sanitized plan to review.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --json
```

Without `--url`, the command uses `vitehub({ publicUrl })` when it is one string. `--stage staging` loads stage env files such as `.env.staging`, and process environment values win. Keep the Telegram bot token and webhook secret in Server Env. The command takes no credential flags and never prints credentials.

To apply the plan, repeat the exact origin in `--confirm-origin`. This works without prompts, so developers, CI, and agents never pick a deployment by accident. The configured `publicUrl` needs no confirmation, but a `--confirm-origin` you add must match it.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --apply \
  --confirm-origin https://staging.example.com
```

`--agent <name>` or `--channel <id>` narrows an app with many Agents. Switching a Telegram Channel to polling, or setting `webhooks: false`, plans to remove its webhook. Applying that also needs `--allow-delete`, and the current provider URL must belong to the confirmed origin. ViteHub keeps pending updates during registration and removal.

Telegram's `getWebhookInfo` returns the URL and delivery errors, but not the secret token or allowed update list, so the plan marks those as unverifiable. Use `--force` to reapply them when the URL matches but credentials or subscriptions changed. Telegram accepts ports 443, 80, 88, and 8443. The CLI rejects other explicit ports before it applies.

`channels sync` only registers the webhook. The Telegram synchronizer subscribes to message updates, the one inbound event the built-in Channel supports. Admission rules, allowed users, secrets, and other update types stay in the app. An app that needs a custom adapter, certificate, fixed IP, or connection policy must manage the provider itself. An app-owned `adapter` is not synced.

## Export a Channel conversation

When the app has the Channel operations, `vitehub channels list` lists Channels and their retention, `channels threads` lists a Channel's threads, and `channels conversation` reads one thread's messages in order. `vitehub channels status <agent> <channel>` shows sync health and skipped messages of a [Gmail Channel](/docs/agents/gmail#failed-messages).

`conversations export` calls the `conversations.export` [operation](/docs/console/operations) on the dev server, or on the app at `--url` with the credentials in [Call a deployed app](/docs/cli/operations#call-a-deployed-app). It needs no webhook secret, only Console access to the `channels` section.

```bash [Terminal]
pnpm vitehub conversations export support telegram telegram:456 > chat.md
pnpm vitehub conversations export support telegram telegram:456 --format json --output ./chat --url https://app.example.com
```

Without `--output`, the text goes to stdout without attachments, and a retention warning goes to stderr. With `--output`, the directory must not exist. It gets the file (`history.json` or `<thread>.md`) and attachments in `media/`. `--media` and `--no-media` override the default. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).

## Download Channel history

`channels history` loads the stage's Agent and Channel configuration and calls the deployed webhook route with its webhook secret. Adapter-backed Channels use the Chat SDK export. A Channel with `history` exports its Collection items, takes repeatable `--query key=value` and optional `--thread`, and pages to the end. `--invocations` joins kept Invocations and recorded deliveries to each item.

The join uses `vitehub.channel.key` annotations first. For older Invocations, a Channel can give `history.invocationItem(invocation)`, which returns a history item or `undefined`, and the exporter calls `history.key()` and optional `history.thread()` on it. The journal keeps observations and run annotations, but not raw webhook input or trusted `input.context`, so recover only identities the kept data supports. A missing item, invalid key, or throwing hook leaves the Invocation unjoined. The exporter scans the journal once per Collection page. It never runs the Channel trigger or changes journal records.

```bash [Terminal]
pnpm vitehub channels history \
  --stage production \
  --url https://app.example.com \
  --agent calories \
  --channel telegram \
  --output ./channel-history
```

`--url` defaults to `vitehub({ publicUrl })` when it is one string. A Telegram direct-message Channel finds its thread when the adapter allows exactly one user. Pass `--thread <provider-thread-id>` for groups and for adapters where one Channel serves many conversations, issues, or tickets. When a Channel declares several webhook registrations, pick the route and its authentication with `--webhook <id>`.

`--webhook-path <path>` exports through another path on the confirmed origin, with the selected registration's authentication. Use it to reach the built-in route on an older deployment that does not serve a declared `webhooks.path` yet.

A custom Channel export holds the items of its history Collection. With `--invocations`, each item has `invocations` with `id`, `status`, `createdAt`, `updatedAt`, `dryRun`, `label`, `deliveries: [{ channel, text }]`, and optional final `text`. Delivery text is the validated reply before app formatting, including dry-run writes. To keep it, you need Invocation content storage or `metadataContent` with `channel.effect.content`.

A Chat SDK export holds only history the adapter or its State Adapter can give. Telegram's Bot API cannot backfill old messages, so it uses the `threadHistory` window: 100 messages kept for seven days by default. For a recovery archive, export before that window ends.

## Replay Channel history

`vitehub channels replay --agent support --channel mailbox --dry-run --label round-one --query folder=inbox` records each run with `triggeredBy: 'round-one'` and `vitehub.channel.key`. Repeat `--query key=value` for several values, as with `--filter`. Labels are not part of the history query. They must be non-empty, at most 512 characters. For a query field named `label`, use `--query label=value`.

Replay needs the development project token or deployed Console authentication. With `--url`, the command calls the `channels.replay` operation on the Console RPC of the deployed app, one page per call. The Agent must allow Console invocation. It checks saved items through the Channel trigger, without rechecking old provider signatures. Public webhooks still verify signatures. In `vite dev`, replay uses the host's Console journal, so local dry runs need no Invocation setup in the app.

