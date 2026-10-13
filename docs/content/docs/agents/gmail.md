---
title: Gmail Channel
description: Run an Agent on each new Gmail message and let hooks label, archive, or trash it.
navigation.order: 40.5
navigation.group: Connect
icon: i-lucide-mail
---

`gmail()` connects one Gmail mailbox to an Agent. Gmail sends a Pub/Sub push notification when mail arrives. The Channel verifies the push, reads the new Inbox messages, and starts one Invocation per message. Agent hooks act on the message through `event.message`.

The Channel owns the Gmail plumbing: push authentication, the history cursor, the watch renewal, label names, and history replay. Your application writes the Agent and its hooks.

On hosts that supply `waitUntil`, the Channel acknowledges an authenticated notification before Gmail API work. Without `waitUntil`, the webhook drains its background work before returning. The first notification verifies the OAuth mailbox in background work before changing the history cursor or handling messages. Later notifications reuse that identity while the configured OAuth credentials are unchanged. Custom `client` functions can rotate credentials behind the same function, so each notification verifies their current mailbox in background work. An authenticated notification for another mailbox is discarded before state or message changes; if the mailbox from configured OAuth credentials is already cached, the webhook rejects it with HTTP 400.

The Channel calls the Gmail REST API with `fetch` and a Google OAuth refresh token. It runs on Node.js, Cloudflare Workers, and Vercel. It is separate from the [`gmail()` Capability](/docs/agents/capabilities/gmail) from `vite-hub/agent/capabilities`, which gives an Agent search and draft tools through the `gog` CLI.

## Label new email

This Agent chooses one label for each new Inbox message. The hook applies it.

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

The Channel adds instructions to the Agent: the email content is untrusted data, and the response does not send an email. It also lists each label that has a `description`. Gmail does not store label descriptions.

## Message data and methods

`event.message.data` is the message that started the Invocation:

| Field | Value |
| --- | --- |
| `id`, `threadId` | Gmail message and thread IDs. |
| `from`, `to`, `cc`, `subject` | Complete header values. `to` and `cc` are arrays of addresses. |
| `date` | ISO 8601 time when Gmail received the message. |
| `snippet` | Gmail's short preview. |
| `labelIds` | Label IDs when Gmail delivered the message. |
| `body` | Plain-text body, decoded with its MIME charset and capped at `bodyLimit` characters (default 10000). HTML-only mail is converted to text. Attachment-backed MIME bodies are fetched before decoding and limiting the text. Filename-bearing and attachment-disposition subtrees are excluded. |
| `attachments` | `{ attachmentId?, filename, mimeType, size }` for each filename-bearing attachment. Inline attachments have no `attachmentId`. The data is not downloaded. |
| `headers` | Headers by lowercase name, such as `list-id`, capped at 1000 characters per value. Transport headers such as `received` and `dkim-signature` are omitted. |

Body decoding supports ISO-8859-1 and the host’s `TextDecoder` encodings. Missing or unsupported charsets use UTF-8 with replacement characters for invalid bytes, so one unsupported charset does not stop mailbox sync. ISO-8859-1 bytes retain their Latin-1 values; Windows-1252 uses its own character mapping.

The default prompt lists the headers, then the body. Pass `prompt: message => string` to build your own.

`event.message` has these methods:

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

Methods take label names. The Channel maps names to IDs with a cached label list. System labels such as `INBOX`, `UNREAD`, and `STARRED` use their IDs as names. A label that you declare in `labels` and that does not exist yet is created on first use with its color. A name that is neither declared nor in Gmail fails the call.

`get()` and `thread()` are read methods. The others are writes: in a [dry run](/docs/agents/channels#dry-run) they are recorded in the Invocation trace and do not change Gmail. Set `gmail({ dryRun: true })` to dry-run every pushed message while you check the Agent's decisions in the Console.

## Set up Google Cloud

You need a Google Cloud project, an OAuth client for the mailbox, and a Pub/Sub topic that Gmail publishes to.

1. Create a Google Cloud project and enable the **Gmail API** and the **Cloud Pub/Sub API**.
2. Configure the **OAuth consent screen**. Add the scope `https://www.googleapis.com/auth/gmail.modify`. For a personal Gmail account, use the External user type and add yourself as a test user. Google expires refresh tokens after seven days while the app is in the Testing publishing status. Publish the app to keep the token.
3. Create an **OAuth client ID**. Its client ID and client secret are `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
4. Get a refresh token for the mailbox with the `gmail.modify` scope, for example with the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) and your own client credentials. The refresh token is `GMAIL_REFRESH_TOKEN`.
5. Create the topic and let Gmail publish to it:

   ```sh
   gcloud pubsub topics create gmail-push
   gcloud pubsub topics add-iam-policy-binding gmail-push \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher
   ```

6. Create a service account that signs the push requests, and a push subscription with OIDC authentication. The push endpoint is the Agent's webhook route: `/api/_vitehub/agents/<agent>/webhooks/<channel>`.

   ```sh
   gcloud iam service-accounts create gmail-push-invoker
   gcloud pubsub subscriptions create gmail-push \
     --topic=gmail-push \
     --push-endpoint=https://mail.example.com/api/_vitehub/agents/labeller/webhooks/gmail \
     --push-auth-service-account=gmail-push-invoker@my-project.iam.gserviceaccount.com \
     --push-auth-token-audience=https://mail.example.com/api/_vitehub/agents/labeller/webhooks/gmail
   ```

   Projects created before April 8, 2021 must also grant the Pub/Sub service agent the Service Account Token Creator role on the invoker service account.

## Configure the credentials

Declare the settings in Server Env under `gmail`. Without a Server Env declaration, the Channel reads the environment variables directly.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub()],
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
})
```

| Server Env key | Environment variable | Value |
| --- | --- | --- |
| `clientId` | `GMAIL_CLIENT_ID` | OAuth client ID. |
| `clientSecret` | `GMAIL_CLIENT_SECRET` | OAuth client secret. |
| `refreshToken` | `GMAIL_REFRESH_TOKEN` | Refresh token of the mailbox, with the `gmail.modify` scope. |
| `pubsubTopic` | `GMAIL_PUBSUB_TOPIC` | Topic of the watch, such as `projects/my-project/topics/gmail-push`. |
| `pubsubAudience` | `GMAIL_PUBSUB_AUDIENCE` | Audience of the push subscription's OIDC token. |
| `pubsubServiceAccount` | `GMAIL_PUBSUB_SERVICE_ACCOUNT` | Email of the service account that signs the push requests. |
| `pubsubSubscription` | `GMAIL_PUBSUB_SUBSCRIPTION` | Full name of the push subscription, such as `projects/my-project/subscriptions/gmail-push`. |

The Channel caches access tokens in process memory. It does not write them to the State Adapter.

To call Gmail through another credential owner, pass `client`. It receives `{ method, path, query, body }`, with `path` relative to `https://gmail.googleapis.com/gmail/v1/users/me/`, and returns the JSON response body. Throw an error with a numeric `status` for an HTTP error.

```ts
gmail({
  client: request => broker.call('gmail', request),
})
```

## Start the watch

Deploy the application first. Then create the managed labels and start the Gmail watch on the topic:

```sh
pnpm vitehub channels sync --stage production --channel gmail
pnpm vitehub channels sync --stage production --channel gmail --apply
```

The first command prints the plan. The Gmail Channel does not need `--url`, because its resources belong to the Gmail account, not to the deployment. See [CLI channel synchronization](/docs/development/cli#synchronize-channel-webhooks).

Gmail permits one active watch per mailbox. `channels sync` reads the mailbox profile and rejects multiple selected Gmail Channels for that mailbox before creating labels or renewing watches, even when the Channels use different credentials.

Gmail stops the watch seven days after the last renewal. The push route renews it when the stored expiration is less than a day away, but a quiet mailbox sends no pushes. Renew it from a daily [Schedule](/docs/schedule) with `syncGmailChannel()`, which runs the same logic as `channels sync`:

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

## How pushes become Invocations

1. Pub/Sub sends a push request with a Google-signed OIDC token. The Channel verifies the signature with Google's public keys, the issuer, the audience, the expiry, and the verified service account email. It then checks the subscription name. A failed check returns `401` or `400`.
2. The Channel acknowledges the push with `204` and continues in the background.
3. It reads `history.list` from the stored history cursor, checks each message’s current labels with a metadata-only request, and fetches bodies for messages still in Inbox. Historical labels do not exclude a message restored to Inbox before that check. Failed dispatches remain eligible for retry after a hook removes Inbox.
4. It starts one Invocation per message through the `received` trigger. The Invocation run ID is `channel:<channel>:<message id>`. A terminal Invocation or confirmed Workflow dispatch is skipped. An active claim prevents concurrent execution. A claim for an unconfirmed pending Invocation remains retryable and does not allow the history cursor to advance.
5. It saves page tokens and remaining message IDs in the Channel's State Adapter as synchronization proceeds. The next push resumes unfinished work without fetching completed message bodies again. After every message has an Invocation, it stores the new history cursor and clears the saved progress in one transaction.

Mailbox synchronization requires a State Adapter with `mutateWithLock(lock, mutations)`. The operation must check the stored lock token and expiry and apply cache writes or deletions in one transaction. ViteHub's memory, SQLite/libsql, and Cloudflare Durable Object adapters implement this atomic contract. Gmail push routes also require persistent State and return HTTP 503 for missing or in-memory State. Use persistent SQLite/libSQL storage or Cloudflare Durable Objects. Custom adapters must implement `AtomicAgentStateLockAdapter` and declare `readonly durable: true` through `DurableAgentStateAdapter`; a separate lease check followed by `set()` or `delete()` is insufficient. Cloudflare mailbox locks use the existing cache actor, preserving stored cursors and watch state even when other thread locks are sharded.

Google OIDC and the Pub/Sub envelope are verified before delivery State is opened or written. Custom SQLite drivers and libSQL clients must set `durable: true` only when their storage survives host restarts. Built-in file and remote libSQL URLs declare persistence automatically; memory URLs remain ineligible.

The first push only stores the cursor. Earlier mail belongs to [replay](#replay-past-mail). When Gmail no longer has the stored history, about a week later, the Channel reads Inbox mail from the last two days and continues from the current history.

One process at a time reads the mailbox. A push that arrives during a sync marks it pending, and the running sync reads once more. Completed messages are skipped on repeated pushes. Inline runs remain eligible for retry until their terminal status is stored; after process loss, the retry can start when the claim expires. Skipping handled messages needs an Invocation journal: configure `invocations` or enable the [Console](/docs/development/console).

The background work runs in the host's `waitUntil`. Cloudflare Workers stop it 30 seconds after the response. For large bursts on Workers, use a [Workflow runtime](/docs/agents/invocations) so each message starts a durable run.

The Channel watches the Inbox of one mailbox. Mail that skips the Inbox through a Gmail filter does not start an Invocation.

## Replay past mail

The Channel provides `history`: past messages from a Gmail search, in the same shape as a pushed message. Replayed and pushed messages share Invocation IDs, so a message runs once however it arrives.

```sh
pnpm vitehub channels replay --agent labeller --channel gmail --query "in:inbox newer_than:30d" --dry-run --limit 50
```

| Query key | Value |
| --- | --- |
| `query` | Gmail search syntax. Defaults to `in:inbox`. |
| `labelIds` | Label IDs that every message must have. Repeat the flag for several. |

See [Replay Channel history](/docs/agents/channels#replay-channel-history) for `replayChannel()`, cursors, and `--force`.
