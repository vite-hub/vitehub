---
title: Write comments offline
description: Save new comments and replies in the browser with their files, show them at once, and send each one once when the network is back.
navigation.title: Offline
navigation.order: 10
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

`account` is the Comments author ID. Use the signed-in user's ID or the full guest author ID. The server checks the author on each upload and write. If the session changes, the old entries wait until that author signs in and calls `retry()`. Set `namespace` to a stable destination key if your origin serves more than one Comments API. Entries saved under one namespace never go out under another. The overlay sets it to the API URL, and Hosted Comments to the Console URL of the project, so two projects on one site keep separate queues.

`create()` and `reply()` show the entry at once, even with no network. They return before the save unless you supply a `requestId`. With a supplied key, they wait for the local save so a replay can return the first draft.

```ts fragment
const thread = await comments.create({
  subject: { kind: 'drop', id: '42' },
  anchor: { kind: 'page' },
  body: 'The price on the yearly plan is wrong.',
  files: [screenshot],
})

thread.delivery // { status: 'pending', requestId: '6f1c…', files: [Blob] }
```

Pass `files` as an array of `Blob` or `File` objects or as a promise for that array. When some files are ready and others render after Send, pass the ready ones as `files` and the rest as `deferredFiles`: a reload before the late ones arrive still sends the ready ones. If saving deferred files fails, Retry saves them again before sending. Without Web Locks, the default outbox uses memory, and a custom store gets drafts in send order once their files are ready. This keeps another tab from sending them early. The page warns before unload while any drafts remain only in memory.

## What the reader sees

A waiting comment is a thread in `comments.threads`, after the threads of the server. A waiting reply is a message at the end of its thread.

| Field | On a waiting thread or message |
| --- | --- |
| `id` | The local draft ID, until the server copy replaces it. Use it for outbox actions. |
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
| `401`, `402` | Waits for `retry()`, such as after a sign-in or a plan upgrade. |
| Any other `4xx` | Moves the entry to `failures`. The next entries go on. |

A reply to a waiting comment waits until the comment is on the server, then goes to its server ID. A refused comment holds its replies until you retry or dismiss it. Replies are saved even if the thread is outside the current list. For an uncached thread, the returned view contains the waiting reply only; it does not add a thread to the list.

When the app is open in several tabs, one tab sends. The others hear each change and show the same entries.

## `comments.outbox`

| Field | What it holds |
| --- | --- |
| `entries` | Every entry of the account, in order. Each has a local `id`, a `requestId`, a `kind` (`create` or `reply`), `input`, `files`, `status`, and an optional `error`. |
| `queued` | The entries that wait or go out now. |
| `failures` | The entries that the server refused. |
| `persisted` | `true` when the entries are in IndexedDB. `false` when they live only in this page, such as in a private window without IndexedDB. |

| Method | Does |
| --- | --- |
| `retry(id?)` | Sends the entry again now. Without `id`, resumes pending entries. |
| `edit(id, body, mentions?)` | Changes the text before it goes out. A refused entry goes back in the queue. |
| `dismiss(id)` | Removes the entry. A comment takes its waiting replies with it. |
| `clear()` | Removes every entry of the account, such as at sign-out. It cannot cancel a request already sent. |

`edit` and `dismiss` return `false` while the entry is on its way or if the server may already have it after a lost write answer. A later refusal does not unlock it. Retry to recover the server copy, then edit or delete it. A lost attachment upload or thread lookup answer does not lock the draft on its own. When the draft is locked, `comments.edit()` and `comments.delete()` fail with `COMMENTS_OUTBOX_SENDING`.

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

A transport gets the `requestId`, the remaining `files`, and `outbox` in `create()` and `reply()`. It gets `subject` in `reply()` for the upload. On each upload and message write, the server must check that the current author matches `outbox.account`. A custom transport must await `outbox.uploaded(key)` after each successful upload, then send the keys in `attachments`. The next attempt gets those keys and skips the saved uploads, even after a reload. Send the first thread back for a repeated `requestId` on the same target.

A reply with a `requestId` gets the message id `await replyMessageId(threadId, requestId)` from `vite-hub/comments/client`, on the server and in the memory transport. Use it to find the server copy of a waiting reply in your own list.

Set `status` on a thrown error so the outbox knows whether to wait, and `retryAfter` in milliseconds to ask for a wait. An error without `status` counts as no answer.

## What it does not do

- It does not queue edits, deletes, or resolves of comments that the server has.
- It does not keep the page itself offline. A reload with no network shows the browser's offline page. The saved entries stay and go out when the app opens again.
