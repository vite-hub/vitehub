---
title: Gmail Channel
description: Run an Agent on each new Gmail message and let hooks label, archive, or trash it.
navigation.order: 42
navigation.group: Channels
icon: i-lucide-mail
navigation.kind: Guides
---

The `gmail()` Channel connects one Gmail mailbox to an Agent. For each new Inbox message, it starts one Invocation (one run of the Agent). Your hooks act on the message through `event.message`.

Read new mail in one or both ways:

- [**Poll**](#poll-without-pubsub): a [Schedule](/docs/schedule) calls `pollGmailChannel()`, for example every five minutes. It needs only a Google OAuth client.
- [**Push**](#add-instant-delivery-with-pubsub): Gmail sends a Pub/Sub notification when mail arrives, so the Channel reads it at once. It also needs a Pub/Sub topic, a push subscription, and a service account.

The Channel handles push authentication, the history cursor, watch renewal, label names, and history replay. It calls the Gmail REST API with `fetch` and a Google OAuth refresh token, and runs on Node.js, Cloudflare Workers, and Vercel.

The [`gmail()` Capability](/docs/agents/capabilities/gmail) from `vite-hub/agent/capabilities` is different: it gives an Agent search and draft tools through the `gog` CLI.

## Label new email

This Agent chooses a label for each new Inbox message, and the hook applies it.

```ts [server/lib/inbox.ts]
import { gmail } from 'vite-hub/agent/channels'

export const inbox = gmail({
  labels: {
    Work: {
      description: 'Email from colleagues, clients, and company tools',
      color: { textColor: '#000000', backgroundColor: '#fad165' },
    },
    Receipts: {
      description: 'Purchases, receipts, and invoices',
      color: { textColor: '#ffffff', backgroundColor: '#16a766' },
    },
    Newsletters: {
      description: 'Newsletters and product updates',
      color: { textColor: '#000000', backgroundColor: '#c9daf8' },
    },
  },
})
```

```ts [server/agents/labeller.ts]
import * as v from 'valibot'
import { defineAgent } from 'vite-hub/agent'
import { inbox } from '../lib/inbox'

export default defineAgent({
  channels: { gmail: inbox },
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Choose the Gmail label that fits the email. Choose "none" when no label clearly fits.',
    output: {
      schema: v.object({ label: v.picklist(['Work', 'Receipts', 'Newsletters', 'none']) }),
    },
  },
  hooks: {
    async 'agent:finish'({ message, result }) {
      if (message?.channel !== 'gmail' || !result || result.label === 'none') return
      await message.label(result.label)
      if (result.label === 'Newsletters') await message.archive()
    },
  },
})
```

The Channel adds instructions that tell the model the email is untrusted data and its response sends no email. They also list each label `description`, which Gmail itself does not store.

## Label colors and visibility

Each label in `labels` accepts these settings. `vitehub channels sync` creates and updates them in Gmail.

| Setting | Value |
| --- | --- |
| `description` | What the label means, added to the Agent instructions. |
| `color` | `{ textColor, backgroundColor }`, both from Gmail's label palette. |
| `labelListVisibility` | Sidebar display: `labelShow` (default), `labelShowIfUnread`, or `labelHide`. |
| `messageListVisibility` | Display on messages in the message list: `show` (default) or `hide`. |

Gmail accepts only the 102 colors of its [label palette](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels#color), exported as `gmailLabelPalette` from `vite-hub/agent/channels`. `gmail()` checks each color at definition, so a wrong color fails before the application starts:

```txt
[vitehub] gmail() label "Work" color backgroundColor "#123456" is not in Gmail's label palette. Use a value from gmailLabelPalette, such as "#4a86e8".
```

Colors are not case-sensitive. A label without `color` keeps its Gmail color.

To hide unmanaged labels from the Gmail sidebar, set `hideUnmanagedLabels: true`:

```ts
import { gmail } from 'vite-hub/agent/channels'

gmail({
  hideUnmanagedLabels: true,
  labels: {
    'GitHub/Bots': { color: { textColor: '#000000', backgroundColor: '#cccccc' } },
    'Work': { color: { textColor: '#000000', backgroundColor: '#fad165' } },
  },
})
```

`channels sync` then sets `labelListVisibility: labelHide` on each undeclared user label. Labels stay on their messages and in search. Parents of declared nested labels (`GitHub` for `GitHub/Bots`) and system labels such as `INBOX` do not change. To show a hidden label again, declare it or show it in Gmail.

## Message data and methods

`event.message.data` is the triggering message:

| Field | Value |
| --- | --- |
| `id`, `threadId` | Gmail message and thread IDs. |
| `from`, `to`, `cc`, `subject` | Complete header values. `to` and `cc` are arrays of addresses. |
| `date` | ISO 8601 time when Gmail received the message. |
| `snippet` | Gmail's short preview. |
| `labelIds` | Label IDs when Gmail delivered the message. |
| `body` | Plain text, decoded with its MIME charset and cut to `bodyLimit` characters (default 10000). HTML-only mail becomes text. A body stored as an attachment is fetched first. Parts with a filename or attachment disposition are left out. |
| `attachments` | `{ attachmentId?, filename, mimeType, size }` for each attachment with a filename. Inline attachments have no `attachmentId`. Data is not downloaded. |
| `headers` | Headers by lowercase name, such as `list-id`, each cut to 1000 characters. Transport headers such as `received` and `dkim-signature` are left out. |

Body decoding supports ISO-8859-1 (bytes keep their Latin-1 values) and the encodings of the host's `TextDecoder`. Windows-1252 uses its own mapping. A missing or unsupported charset falls back to UTF-8 with replacement characters, so it does not stop the mailbox sync.

The default prompt lists the headers, then the body. Pass `prompt: message => string` for your own.

`event.message` methods:

| Method | Gmail call |
| --- | --- |
| `get()` | Reads the current message. Returns `undefined` when it was deleted. |
| `thread()` | Reads every message of the conversation. |
| `label(name)` or `label([names])` | Adds labels. |
| `modify({ addLabels, removeLabels })` | Adds and removes labels in one call. |
| `archive()` | Removes `INBOX`. |
| `markRead()` | Removes `UNREAD`. |
| `star()` | Adds `STARRED`. |
| `trash()` | Moves the message to Trash. Gmail deletes it after 30 days. |

Methods take label names and map them to IDs with a cached label list. System labels such as `INBOX`, `UNREAD`, and `STARRED` use their IDs as names. The first call creates a declared label that does not exist yet, with its color. A name that is neither declared nor in Gmail fails.

`get()` and `thread()` read; the others write. In a [dry run](/docs/agents/channels#dry-run), writes go to the Invocation trace, not Gmail. Set `gmail({ dryRun: true })` to dry-run every pushed message and check the Agent's decisions in the Console first.

## Set up Google Cloud

You need a Google Cloud project and an OAuth client. Push also needs a Pub/Sub topic (steps 5 and 6).

1. Create a Google Cloud project and enable the **Gmail API**, plus the **Cloud Pub/Sub API** for push.
2. Configure the **OAuth consent screen** with the scope `https://www.googleapis.com/auth/gmail.modify`. For a personal Gmail account, use the External user type and add yourself as a test user. In Testing publishing status, Google expires refresh tokens after seven days, so publish the app.
3. Create an **OAuth client ID**. Its ID and secret are `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
4. Get a mailbox refresh token with the `gmail.modify` scope, such as with the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) and your own client credentials. This is `GMAIL_REFRESH_TOKEN`.

To only poll, stop here. For push, continue:

5. Create the topic and let Gmail publish to it:

   ```sh
   gcloud pubsub topics create gmail-push
   gcloud pubsub topics add-iam-policy-binding gmail-push \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher
   ```

6. Create a service account that signs push requests, and a push subscription with OIDC authentication to the Agent's webhook route, `/api/_vitehub/agents/<agent>/webhooks/<channel>`.

   ```sh
   gcloud iam service-accounts create gmail-push-invoker
   gcloud pubsub subscriptions create gmail-push \
     --topic=gmail-push \
     --push-endpoint=https://mail.example.com/api/_vitehub/agents/labeller/webhooks/gmail \
     --push-auth-service-account=gmail-push-invoker@my-project.iam.gserviceaccount.com \
     --push-auth-token-audience=https://mail.example.com/api/_vitehub/agents/labeller/webhooks/gmail
   ```

   For a project created before April 8, 2021, also give the Pub/Sub service agent the Service Account Token Creator role on the invoker service account.

## Configure the credentials

Declare the settings under `gmail` in Server Env (the typed server settings that ViteHub reads from the environment), or the Channel reads the environment variables directly. Poll needs the OAuth settings; push also needs `pubsub*`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      server: {
        gmail: {
          clientId: env({ source: env.source('GMAIL_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GMAIL_CLIENT_SECRET') }),
          refreshToken: env({ secret: true, source: env.source('GMAIL_REFRESH_TOKEN') }),
          pubsubTopic: env({ source: env.source('GMAIL_PUBSUB_TOPIC') }),
          pubsubAudience: env({ source: env.source('GMAIL_PUBSUB_AUDIENCE') }),
          pubsubServiceAccount: env({ source: env.source('GMAIL_PUBSUB_SERVICE_ACCOUNT') }),
          pubsubSubscription: env({ source: env.source('GMAIL_PUBSUB_SUBSCRIPTION') }),
        },
      },
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
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        gmail: {
          clientId: env({ source: env.source('GMAIL_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GMAIL_CLIENT_SECRET') }),
          refreshToken: env({ secret: true, source: env.source('GMAIL_REFRESH_TOKEN') }),
          pubsubTopic: env({ source: env.source('GMAIL_PUBSUB_TOPIC') }),
          pubsubAudience: env({ source: env.source('GMAIL_PUBSUB_AUDIENCE') }),
          pubsubServiceAccount: env({ source: env.source('GMAIL_PUBSUB_SERVICE_ACCOUNT') }),
          pubsubSubscription: env({ source: env.source('GMAIL_PUBSUB_SUBSCRIPTION') }),
        },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        gmail: {
          clientId: env({ source: env.source('GMAIL_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GMAIL_CLIENT_SECRET') }),
          refreshToken: env({ secret: true, source: env.source('GMAIL_REFRESH_TOKEN') }),
          pubsubTopic: env({ source: env.source('GMAIL_PUBSUB_TOPIC') }),
          pubsubAudience: env({ source: env.source('GMAIL_PUBSUB_AUDIENCE') }),
          pubsubServiceAccount: env({ source: env.source('GMAIL_PUBSUB_SERVICE_ACCOUNT') }),
          pubsubSubscription: env({ source: env.source('GMAIL_PUBSUB_SUBSCRIPTION') }),
        },
      },
    },
  })],
})
```
:::
::

| Server Env key | Environment variable | Value |
| --- | --- | --- |
| `clientId` | `GMAIL_CLIENT_ID` | OAuth client ID. |
| `clientSecret` | `GMAIL_CLIENT_SECRET` | OAuth client secret. |
| `refreshToken` | `GMAIL_REFRESH_TOKEN` | Mailbox refresh token with the `gmail.modify` scope. |
| `pubsubTopic` | `GMAIL_PUBSUB_TOPIC` | Push only. Watch topic, such as `projects/my-project/topics/gmail-push`. |
| `pubsubAudience` | `GMAIL_PUBSUB_AUDIENCE` | Push only. Audience of the subscription's OIDC token. |
| `pubsubServiceAccount` | `GMAIL_PUBSUB_SERVICE_ACCOUNT` | Push only. Email of the service account that signs push requests. |
| `pubsubSubscription` | `GMAIL_PUBSUB_SUBSCRIPTION` | Push only. Full subscription name, such as `projects/my-project/subscriptions/gmail-push`. |

The push route returns HTTP 503 until `pubsubAudience`, `pubsubServiceAccount`, and `pubsubSubscription` are set.

Access tokens stay in process memory, never in the State Adapter (where the Channel keeps its state).

To call Gmail through another credential owner, pass a `client` function. It receives `{ method, path, query, body }`, with `path` relative to `https://gmail.googleapis.com/gmail/v1/users/me/`, and returns the JSON response body. Query values have Gmail API types: repeated parameters such as `historyTypes` or `labelIds` are arrays, and flags such as `includeSpamTrash` are booleans. For an HTTP error, it throws an error with a numeric `status`.

```ts fragment
gmail({
  client: request => broker.call('gmail', request),
})
```

## Poll without Pub/Sub

Call `pollGmailChannel()` from a [Schedule](/docs/schedule). Each call reads new Inbox messages since the stored history cursor and starts one Invocation per message:

```ts [server/schedules/gmail-poll.ts]
import { defineSchedule } from 'vite-hub/schedule'
import { pollGmailChannel } from 'vite-hub/agent/channels'
import { inbox } from '../lib/inbox'

export default defineSchedule({
  cron: '*/5 * * * *',
  async handler() {
    await pollGmailChannel(inbox)
  },
})
```

With this cron, an Invocation starts up to five minutes after mail arrives. `pollGmailChannel()` runs the Channel of each Agent that uses `inbox`, with the same State as its webhook route, and waits until every new message has an Invocation. On sync failure it throws, so the Schedule reports it, and the cursor stays for the next poll.

Like push, it needs durable Agent State: libSQL with `VITEHUB_AGENT_STATE_URL`, or Cloudflare Durable Objects. Outside a host request, pass `runtime` for Server Env and Cloudflare bindings, as with `syncGmailChannel()`.

Poll and push share the history cursor, mailbox lock, and Invocation IDs, so a message runs only once. Keep the poll as a fallback with push: it reads mail from undelivered pushes and renews a due watch when `pubsubTopic` is set. Create managed labels with `channels sync` (next section), which starts no watch without `pubsubTopic`.

## Start the watch

For push, a watch tells Gmail to publish mailbox changes to your Pub/Sub topic. Deploy first, then create the managed labels and start the watch:

```sh
pnpm vitehub channels sync --stage production --channel gmail
pnpm vitehub channels sync --stage production --channel gmail --apply
```

The first command prints the plan: labels to create, labels whose color or visibility changes, unmanaged labels to hide (with `hideUnmanagedLabels`), and the watch. `--apply` makes the changes. No `--url` is needed, because the resources belong to the Gmail account, not the deployment. See [CLI channel synchronization](/docs/development/cli#synchronize-channel-webhooks).

Gmail allows one active watch per mailbox. `channels sync` reads the mailbox profile first and stops before any change if you select more than one Gmail Channel for the same mailbox, even with different credentials.

Gmail stops the watch seven days after the last renewal. The push route renews it when the stored expiration is under a day away, but a quiet mailbox sends no pushes. Renew it from a daily [Schedule](/docs/schedule) with `syncGmailChannel()`, which runs the same logic as `channels sync`:

```ts [server/schedules/gmail-watch.ts]
import { defineSchedule } from 'vite-hub/schedule'
import { syncGmailChannel } from 'vite-hub/agent/channels'
import { inbox } from '../lib/inbox'

export default defineSchedule({
  cron: '0 6 * * *',
  async handler() {
    await syncGmailChannel(inbox, { apply: true })
  },
})
```

## Add instant delivery with Pub/Sub

To start Invocations as soon as mail arrives, do steps 5 and 6 of [Set up Google Cloud](#set-up-google-cloud), set the `pubsub*` settings, and [start the watch](#start-the-watch).

## How pushes become Invocations

A poll runs steps 3 to 5 from a Schedule, without a notification.

1. Pub/Sub sends a push with a Google-signed OIDC token. The Channel checks the signature with Google's public keys, the issuer, audience, expiry, verified service account email, and subscription name. A failed check returns `401` or `400`.
2. It acknowledges with `204` and continues in the background.
3. It reads `history.list` from the stored cursor, checks each message's current labels with a metadata-only request, and fetches bodies of messages still in the Inbox. Older labels from the history do not exclude a message that went back to the Inbox before this check. If a dispatch failed, the message can still be retried after a hook removes it from the Inbox.
4. It starts one Invocation per message through the `received` trigger, with run ID `channel:<channel>:<message id>`. It skips a message whose Invocation is terminal (finished) or whose Workflow dispatch is confirmed. An active claim stops two concurrent runs of one message. A claim for an unconfirmed pending Invocation stays retryable and holds the cursor until the message is [skipped](#failed-messages).
5. It saves page tokens and remaining message IDs in the State Adapter, so the next push continues without refetching completed bodies. When every message has an Invocation or was [skipped](#failed-messages), it stores the new cursor and clears the progress in one transaction.

### Mailbox identity

- With host `waitUntil`, an authenticated notification is acknowledged before Gmail API calls. Without it, the webhook finishes background work first.
- The first notification checks the credentials' mailbox in background work, before cursor or message changes. Later ones reuse it while credentials stay the same. A custom `client` can rotate credentials, so with `client`, every notification checks.
- A notification for another mailbox is discarded before any change, or rejected with HTTP 400 when the configured mailbox is cached.

### State requirements

- Mailbox sync needs a State Adapter with `mutateWithLock(lock, mutations)`, which checks the stored lock token and expiry and applies cache writes or deletions in one transaction. ViteHub's memory, SQLite/libsql, and Cloudflare Durable Object adapters implement it.
- Push routes return HTTP 503 when State is missing or in memory. Use persistent SQLite/libSQL storage or Cloudflare Durable Objects.
- A custom adapter must implement `AtomicAgentStateLockAdapter` and declare `readonly durable: true` through `DurableAgentStateAdapter`. A lease check followed by `set()` or `delete()` is not enough.
- On Cloudflare, mailbox locks use the existing cache actor, and cursors and watch state stay even when other thread locks are sharded.
- Custom SQLite drivers and libSQL clients set `durable: true` only when storage survives restarts. Built-in file and remote libSQL URLs declare it; memory URLs never qualify.

The Channel verifies Google OIDC and the Pub/Sub envelope before it opens or writes delivery State.

### Cursor, locks, and limits

The first push or poll only stores the cursor; [replay](#replay-past-mail) reads earlier mail. Gmail keeps history for about a week. When the stored history is gone, the Channel reads the last two days of Inbox mail and continues from the current history.

One process at a time reads the mailbox. A push during a sync makes the running sync read once more. Repeated pushes skip completed messages, which needs an Invocation journal: configure `invocations` or enable the [Console](/docs/development/console). An inline run stays retryable until its terminal status is stored; if the process is lost, the retry starts when the claim expires.

Background work runs in the host's `waitUntil`, which Cloudflare Workers stop 30 seconds after the response. For large bursts on Workers, use a [Workflow runtime](/docs/agents/invocations) so each message starts a durable run.

Only the Inbox of one mailbox is watched. Mail that a Gmail filter moves past the Inbox starts no Invocation.

## Failed messages

A failed message does not block later mail. When a message keeps failing (Gmail cannot return it, its body fetch times out, or its Invocation cannot start), the Channel retries it on the next `maxAttempts` syncs (default 5). Then it records the message as skipped in State and lets the cursor move on.

```ts
import { gmail } from 'vite-hub/agent/channels'

gmail({ maxAttempts: 3 })
```

During retries, the sync stops at a failed fetch, and the cursor stays at a failed Invocation. OAuth token refresh failures and HTTP 401, 403, and 429 errors are account problems, not message attempts. A failed Invocation is terminal: the next sync does not rerun it, and the Console shows it.

`vitehub channels status` shows sync health and messages:

```sh
pnpm vitehub channels status labeller gmail --url https://mail.example.com
```

| Field | Value |
| --- | --- |
| `status` | `failing` after two failed syncs in a row (a sync that keeps a retried message also fails), else `ok`. |
| `failures`, `failingSince`, `error` | Current failure streak and its last error. |
| `syncedAt` | When the history cursor last advanced. |
| `retrying` | Messages that the next sync retries, with `id`, `attempts`, and the last `error`. |
| `skipped` | The last 100 skipped messages, newest first, with `id`, `attempts`, the last `error`, and `skippedAt`. |

Errors never contain a message body; they are redacted and cut to 500 characters. Invocation failures show a generic error, because Driver (model) errors can include email content. The `channels.status` [operation](/docs/agents/channels#operations-and-commands) returns the same data through Console RPC and MCP.

Server code reads the same status with `gmailChannelStatus()`, for example for a health route that an uptime check calls:

```ts [server/api/health.get.ts]
import { defineEventHandler } from 'h3'
import { gmailChannelStatus } from 'vite-hub/agent/channels'
import { inbox } from '../lib/inbox'

export default defineEventHandler(async () => {
  const health = await gmailChannelStatus(inbox)
  return Response.json(health ?? { status: 'unknown' }, { status: health?.status === 'ok' ? 200 : 503 })
})
```

It returns `undefined` when no Agent of the app uses the Channel. When more than one Agent uses it, pass `{ agent: 'labeller' }`. Like `pollGmailChannel()`, it reads the State of the webhook route, and outside a host request it takes `runtime` for Server Env and Cloudflare bindings.

To retry a skipped message, replay it. It leaves `skipped` when its Invocation starts:

```sh
pnpm vitehub channels replay --agent labeller --channel gmail --ids 18f2c0a1b2c3d4e5 --url https://mail.example.com
```

Repeat `--ids` for several messages. Add `--force` if the last attempt left a failed Invocation.

## Replay past mail

Replay runs the Agent on past mail. The Channel's `history` returns messages from a Gmail search, shaped like pushed messages and sharing their Invocation IDs, so each message runs only once.

```sh
pnpm vitehub channels replay --agent labeller --channel gmail --query "in:inbox newer_than:30d" --dry-run --limit 50
```

| Query key | Value |
| --- | --- |
| `query` | Gmail search syntax. Defaults to `in:inbox`. |
| `labelIds` | Label IDs that every message must have. Repeatable. |
| `ids` | Message IDs to read instead of a search, such as skipped messages. Repeatable. |

See [Replay Channel history](/docs/agents/channels#replay-channel-history) for `replayChannel()`, cursors, and `--force`.

## Call the Gmail API

`gmailClient(channel)` returns the Gmail REST client of a Channel, with the same credentials. Use it for a request that the Channel does not make, such as a search. Paths are relative to `users/me/`:

```ts [server/api/old-promotions.get.ts]
import { defineEventHandler } from 'h3'
import { gmailClient } from 'vite-hub/agent/channels'
import { getRuntimeContext } from 'vite-hub/runtime'
import { inbox } from '../lib/inbox'

export default defineEventHandler(async (event) => {
  const gmail = await gmailClient(inbox, { runtime: getRuntimeContext(event) })
  return await gmail({ method: 'GET', path: 'messages', query: { q: 'label:Promotions older_than:14d' } })
})
```

To move old labelled mail to Trash on a Schedule, use the [Labeller preset](/docs/agents/labeller#clean-up-old-mail) and its `cleanup` option.
