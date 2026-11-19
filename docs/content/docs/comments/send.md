---
title: Send comments to your agent
description: One click in the comment pill hands the comments that wait for an answer to your own T3 Code thread, through a signed webhook.
navigation.title: Send
navigation.order: 6
icon: i-lucide-send
---

**Send** hands the comments on a page that wait for an answer to your own agent, such as a T3 Code thread. The comment pill shows **Send 2** when two threads wait. Each person pairs their own agent once, in the pill.

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export const comments = defineComments({
  authorize: ({ user }) => user?.role === 'editor',
  send: true,
})
```

That is all the app writes. You need a ViteHub app with `database` on, as in [With ViteHub](/docs/comments/with-vite-hub). Send turns on [member endpoints](/docs/webhooks/member-endpoints) of Webhooks for you, with no Queue.

Send shows for people who are signed in and whom `authorize` lets write on the page. Guests never see it.

## Set it up

1. Run `vitehub database generate` and `vitehub database migrate`. They add the `vitehub_comment_sends` and `vitehub_comment_send_codes` tables, and the endpoint table of Webhooks. `vite dev` applies the migration for you.
2. Set `VITEHUB_WEBHOOKS_KEY` as a secret on the host, from `openssl rand -base64 32`. It seals the URL and the secret of each agent. `vite dev` makes one in `.vitehub/data/webhooks-key`.

## Pair your T3 Code thread

You pair once, in the pill:

1. Press **Send** in the comment pill. The pill copies a setup prompt and says **Paste it in the T3 thread**.
2. Paste the prompt in the T3 Code thread that should get your comments. The agent creates a T3 task that runs on a webhook, and posts the task's URL to your site with the code of the prompt.
3. The pill asks once: **T3 Code · relay.t3.codes wants your comments from this site**. Press **Allow and send**.

The setup code works once, for 10 minutes, and only for the person who copied it. The agent follows these steps from the prompt:

- It calls the T3 tool `schedule_task` with a webhook schedule. The signature is `x-hub-signature-256`, hex, after `sha256=`, with a secret that your server made for this code. The replay key is `{{headers.x-vitehub-delivery}}`, so T3 runs each delivery once. `bindToCurrentThread: true` posts each run in the same thread, and `freshSession: true` starts each run with a fresh session.
- It posts the `webhookUrl` that `schedule_task` returns:

```bash [Terminal]
curl -sS -X POST https://joyandmaxi.com/_vitehub/comments/send/pair \
  -H 'content-type: application/json' \
  -d '{"code":"K7QM-4XPA-9RTC","url":"https://relay.t3.codes/hooks/..."}'
```

```json [Response]
{ "data": { "status": "paired", "agent": { "name": "T3 Code", "logo": "t3", "host": "relay.t3.codes" } } }
```

A code that is too old answers `410` with `"reason": "expired"`, a used code `409` with `"used"`, and a URL that is not safe `422` with `"refused"`. Then press **Copy again** in the pill for a new code.

For Claude Code or Codex, the agent posts `{ "code": "...", "inbox": "Claude Code" }` or `"Codex"` in place of `url`. Your site then posts nothing, and the agent reads the send with the `comments_get_send` MCP tool.

## Send

After the pairing, **Send N** sends at once. The pill shows **Sending**, **Sent**, then **Working** until the agent answers. When the delivery fails, it shows **Not delivered** and **Retry**.

**N** counts the open threads on the page that you may read, whose last message is not an agent's, and that have a message newer than their last send. Threads of other people count too. A thread that was sent and has no new message does not count.

A send is done when each thread that you wrote has left that set: it is resolved, deleted, or an agent answered last.

## What your agent gets

Each send is one signed `POST`, with this body:

```json [comments.send]
{
  "event": "comments.send",
  "send": "send_3f1c…",
  "page": "https://joyandmaxi.com/notes/azores-slowly",
  "threads": ["thr_8a…", "thr_c2…"],
  "count": 2,
  "read": { "url": "https://joyandmaxi.com/_vitehub/comments/send/send_3f1c…", "token": "vhs_…" },
  "text": "Send send_3f1c…: 2 comment threads wait for an answer. Asks: thr_8a…. Quotes: thr_c2…. …",
  "data": null
}
```

- `text` has fixed words and ids only. It never holds what people wrote, so the comments never land in a prompt template.
- **Asks** are your own threads, and threads where you spoke last. **Quotes** are the others: context from other people.
- `read` opens the threads of this send for 24 hours. `GET read.url` with the header `authorization: Bearer <token>` returns exactly those threads, marked `ask` or `quote`, as you may read them. Reading sets the pill to **Working**.

```ts [server/comments.ts]
export const comments = defineComments({
  send: {
    // The agent reads through your own MCP server: no read token.
    grant: false,
    // Extra fields for your agent, in `data`.
    payload: ({ subject }) => ({ document: subject.id }),
    // Other hosts that a paired URL may use. Default: the T3 Code relay.
    hosts: ['relay.t3.codes'],
  },
})
```

## Security

- **The code is the only key of the pair route.** `POST /send/pair` takes any origin, because the agent posts from its own machine. Every other Send route takes requests from the site's own pages only.
- **Allow binds the agent to you.** Only the person who copied the code can allow it. Nothing is saved before Allow.
- **The URL guard** refuses a URL that is not `https`, that is not on `relay.t3.codes` (or `hosts`), or that names a private or cloud metadata address. See [The URL guard](/docs/webhooks/member-endpoints#the-url-guard).
- **Sealed at rest.** The URL and secret of your agent, and the secret of a setup code, are sealed with `VITEHUB_WEBHOOKS_KEY`. A read token is kept as its hash.
- **Limits.** Each person sends at most 30 times an hour. The pill shows **Limit reached, try at 15:10** until then.

::details{summary="Routes"}
| Route | Who | Does |
| --- | --- | --- |
| `GET /_vitehub/comments/send/status?page=` | The person | Count, agent, and the send the agent works on |
| `POST /send/start?page=` | The person | A setup code and its prompt |
| `POST /send/pair` | The agent, any origin | Pairs with `{ code, url }` or `{ code, inbox }` |
| `GET /send/pair/<code>` | The person | `waiting`, `paired`, `expired`, or `refused` |
| `DELETE /send/pair/<code>` | The person | Drops the code |
| `POST /send/allow?page=` | The person who copied the code | Saves the agent and sends |
| `POST /send?page=` | The person | Sends |
| `GET /send/<id>` | The agent, with the read token | The threads of the send |
::

## Your own pill

`CommentSend` of `@vite-hub/ui` draws the Send segment, and `createCommentSendTransport()` talks to these routes. Drop renders them in its own pill:

```vue [app/components/SendSegment.vue]
<script setup lang="ts">
import { CommentSend } from '@vite-hub/ui'
import { createCommentSend, createCommentSendTransport } from 'vite-hub/comments/client'

const send = createCommentSend(createCommentSendTransport({ page: () => location.pathname }))
</script>

<template>
  <CommentSend :client="send" />
</template>
```
