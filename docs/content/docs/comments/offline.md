---
title: Write comments offline
description: Save each new comment and reply in the browser with its files, show it at once, and send it once when the network is back, with the outbox of createCommentsClient().
navigation.title: Offline
navigation.order: 6
icon: i-lucide-inbox
---

## Turn on the outbox

The **outbox** saves each new comment and reply in the browser before it goes to the server. The reader sees it at once, a reload keeps it, and it goes out once as soon as the network lets it. Pass `outbox` to `createCommentsClient()`:

```ts [app/comments.ts] fragment
import { createCommentsClient, createRestTransport } from 'vite-hub/comments/client'

export const comments = createCommentsClient({
  transport: createRestTransport(),
  user,
  query: { subject: { kind: 'drop', id: '42' } },
  outbox: { account: user.id },
})

comments.start()
```

`account` is who writes, such as the user id or a guest id. The outbox sends only the entries of its account, so a comment never goes out as another person.

Now `create()` and `reply()` return as soon as the entry is saved, also with no network:

```ts fragment
const thread = await comments.create({
  subject: { kind: 'drop', id: '42' },
  anchor: { kind: 'page' },
  body: 'The price on the yearly plan is wrong.',
  files: [screenshot],
})

thread.delivery // { status: 'pending', requestId: '6f1c…', files: [Blob] }
```

`files` are `Blob` or `File` objects. The outbox keeps them with the entry, and the transport stores them before the comment.

## What the reader sees

A waiting comment is a thread in `comments.threads`, after the threads of the server. A waiting reply is a message at the end of its thread.

| Field | On a waiting thread or message |
| --- | --- |
| `id` | The `requestId`, until the server copy replaces it. |
| `n` | `0`: the server gives the number. |
| `delivery.status` | `pending` while it waits or goes out. `failed` when the server refused it. |
| `delivery.error` | Why the last try did not go out: `status`, `why`, and `code` and `fix` when the server sent them. |
| `delivery.files` | The files, to show before the server stores them. |

When the server answers, its copy replaces the waiting one by `requestId`. A `refresh()` that already lists the server copy shows it once.

## When it sends

The outbox sends one entry at a time, in the order they were written. Each one carries its `requestId`, so a resend after a lost answer returns the first comment and creates no second one.

| Answer | The outbox |
| --- | --- |
| No answer, `408`, `429`, `5xx` | Waits and tries again: after `Retry-After` when the server sends it, else after 1 s, doubling to 30 s. It tries at once when the page is back online or visible. |
| `401` | Waits for `retry()`, such as after a sign-in. |
| Any other `4xx` | Moves the entry to `failures`. The next entries go on. |

A reply to a waiting comment waits until the comment is on the server, then goes to its server id. A refused comment holds its replies until you retry or dismiss it.

When the app is open in several tabs, one tab sends. The others hear each change and show the same entries.

## `comments.outbox`

| Field | What it holds |
| --- | --- |
| `entries` | Every entry of the account, in order. Each has `requestId`, `kind` (`create` or `reply`), `input`, `files`, `status`, and `error`. |
| `queued` | The entries that wait or go out now. |
| `failures` | The entries that the server refused. |
| `persisted` | `true` when the entries are in IndexedDB. `false` when they live only in this page, such as in a private window without IndexedDB. |

| Method | Does |
| --- | --- |
| `retry(requestId?)` | Sends the entry again now. Without `requestId`, the whole queue tries again. |
| `edit(requestId, body, mentions?)` | Changes the text before it goes out. A refused entry goes back in the queue. |
| `dismiss(requestId)` | Removes the entry. A comment takes its waiting replies with it. |
| `clear()` | Removes every entry of the account, such as at sign-out. |

`edit` and `dismiss` return `false` while the entry is on its way. `comments.edit()` and `comments.delete()` on a waiting comment or reply change the entry and send nothing. While it is on its way, they fail with `COMMENTS_OUTBOX_SENDING`.

`comments.onChange()` tells every change of the outbox. `comments.start()` also sends what an earlier page saved.

Warn before the tab closes while something waits:

```ts fragment
addEventListener('beforeunload', (event) => {
  if (comments.outbox.entries.length > 0) event.preventDefault()
})
```

## Options

| Option | Default | Does |
| --- | --- | --- |
| `account` | Required | Who writes. Only this account's entries show and send. |
| `store` | IndexedDB database `vitehub-comments`, else memory | Where the entries live. `createMemoryOutboxStore()` keeps them in memory. |
| `environment` | The browser | Online and visible events, Web Locks, BroadcastChannel, and timers. Tests pass a fake one. |

## Custom transports

A transport gets the `requestId` and the `files` in `create()` and `reply()`, and `subject` in `reply()` for the upload. `createRestTransport()` and `createRpcTransport()` upload each file, then send the keys in `attachments`. A transport of your own does the same, and sends the same thread back for a repeated `requestId`.

Set `status` on a thrown error so the outbox knows whether to wait, and `retryAfter` in milliseconds to ask for a wait. An error without `status` counts as no answer.

## What it does not do

- It does not queue edits, deletes, or resolves of comments that the server has.
- It does not keep the page itself offline. A reload with no network shows the browser's offline page. The saved entries stay and go out when the app opens again.
