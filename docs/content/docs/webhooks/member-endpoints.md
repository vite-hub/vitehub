---
title: Member endpoints
description: Give each member of the app their own receiver, such as their T3 Code thread, sealed in the Database and posted in the request with no Queue.
navigation.title: Member endpoints
navigation.order: 10
icon: i-lucide-users
---

A **member endpoint** is a receiver that belongs to one member of the app, such as the T3 Code thread of Ana. A file of `server/webhooks/` has one URL for the whole app. A member endpoint has one URL for each member, and the member sets it at runtime.

| | `server/webhooks/<name>.ts` | Member endpoint |
| --- | --- | --- |
| Who sets the URL | The developer, in a server variable | The member, at runtime |
| Where the URL lives | A server variable | The Database, sealed |
| How it is sent | Through the Queue, with an optional debounce | In the request, with a 10 second timeout |
| Needs | `queue` and `database` | `database` |

A ViteHub feature that sends to members turns member endpoints on, such as Send in Comments. You do not add a file.

## Connect a member

`createMemberEndpoint()` stores the receiver of one member and returns it without the URL or the secret:

```ts [server/utils/connect-agent.ts]
import { createMemberEndpoint } from 'vite-hub/webhooks'

/** Runs after Ana allows her T3 Code thread to get her comments. */
export async function connectAgent(user: { id: string, name: string, email: string, emailVerified: boolean }, url: string, secret: string) {
  const [error, endpoint] = await createMemberEndpoint({
    owner: user.id,
    ownerName: user.name,
    // Only a verified email. Auth checks the current owner again on each Console call.
    ownerEmail: user.emailVerified ? user.email : undefined,
    name: 'Launch plan thread',
    agent: 't3',
    kind: 'url',
    url,
    secret,
  })
  if (error) return { error: error.code }
  return { host: endpoint.host }
}
```

- `owner` is the member, such as the Auth user id. A member has one endpoint per `address`; a new one replaces the endpoint at the same address. Omit `address` for a receiver that is not tied to a thread.
- `ownerName` is the name that admins see in the Console. `ownerEmail` is the member's email, only when it is verified. See [Who owns an endpoint](#who-owns-an-endpoint).
- `url` must be `https` on the T3 Code relay, `relay.t3.codes`. Pass `hosts` to allow other hosts. See [The URL guard](#the-url-guard).
- `kind: 'inbox'` takes no URL. Webhooks posts nothing, and the member's agent reads the delivery, such as Claude Code or Codex through MCP.

ViteHub seals the URL and the secret with AES-GCM and the key in `VITEHUB_WEBHOOKS_KEY` before it stores them. The `vitehub_webhook_endpoints` table keeps only the host in plain text.

## Send to a member

`sendToMemberEndpoint(owner, body, { event, key })` posts the JSON body to the member's receiver and returns `[error, { id, status }]`:

```ts [server/utils/send-comments.ts]
import { sendToMemberEndpoint } from 'vite-hub/webhooks'

export async function sendComments(userId: string, threads: Array<{ id: string, lastMessageId: string }>) {
  const [error, sent] = await sendToMemberEndpoint(userId, { threads: threads.map(thread => thread.id) }, {
    event: 'comments.send',
    // The same comments give the same key, so a second click posts nothing.
    key: threads.map(thread => `${thread.id}:${thread.lastMessageId}`).join(','),
  })
  if (error) return { error: error.code }
  return sent
}
```

- The receiver gets the same headers and signature as a [webhook delivery](/docs/webhooks/server-api#the-request): `x-hub-signature-256`, `x-vitehub-delivery`, and `x-vitehub-event`.
- `key` makes the send idempotent. A send with the key of a pending, sending, or sent delivery returns that delivery and posts nothing. After a delivery goes dead, the same key posts again. If the Queue rejects the retry, the call returns `WEBHOOKS_WAKE_FAILED` and marks the delivery dead.
- `status` is `'sent'` for a 2xx answer, `'inbox'` for an inbox, `'failed'` when the post failed, and `'pending'` when the Queue tries again.

The post runs in the request, so the app needs no Queue. When the app has `queue` on, a failed post goes to the `vitehub-webhooks` Queue, which tries it again as it does for a [webhook delivery](/docs/webhooks/limits-and-errors#delivery). Without Queue, a failed post is `failed` at once, and the delivery is `dead`.

Each send is a delivery in `vitehub_webhook_deliveries`, with `webhook` set to `@<endpoint id>`, so `listWebhookDeliveries()` shows it.

## The URL guard

A member gives the URL, so ViteHub checks it with `hosts` before it stores it, and checks its address again before each post. `checkWebhookUrl(url, { hosts })` runs the same check:

```ts [server/utils/check-receiver.ts]
import { checkWebhookUrl } from 'vite-hub/webhooks'

export async function checkReceiver(url: string) {
  const [error, parsed] = await checkWebhookUrl(url, { hosts: ['relay.t3.codes'] })
  return error ? error.why : `OK: ${parsed.host}`
}
```

It refuses a URL that:

- does not use `https`, or holds a user name or a password;
- has a host outside `hosts`. A host does not match its subdomains;
- names a loopback, private, link-local, or cloud metadata address, such as `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, or `[::1]`;
- on Node, Bun, and Deno, has a name that resolves to one of these addresses, or does not resolve.

When Webhooks resolves a name before delivery, it connects only to an address it checked for that attempt. TLS still checks the original hostname. Webhooks never follows a redirect, because a redirect would send the signed body to another place.

> [!WARNING]
> Cloudflare Workers cannot resolve a host name, so there a name passes on `hosts` alone. Keep `hosts` to hosts that you trust, such as the default `relay.t3.codes`.

## The key

`VITEHUB_WEBHOOKS_KEY` holds 32 random bytes in base64. Generate one and set it as a secret on the host:

```bash
openssl rand -base64 32
```

`vite dev` generates a key in `.vitehub/data/webhooks-key` when the app sets none, and app tests get a random key. A build never generates one: without the key, `createMemberEndpoint()` and `sendToMemberEndpoint()` return [`WEBHOOKS_KEY_UNSET`](/docs/webhooks/diagnostics/webhooks_key_unset). A new key cannot open the endpoints that the old key sealed, so members connect again after you change it.

## Manage endpoints

| Function | Does |
| --- | --- |
| `getMemberEndpoint(owner, { address? })` | The member's endpoint at that address, otherwise their newest endpoint, or `null` |
| `listMemberEndpoints({ limit?, after? })` | A page of endpoints, with `last`, the newest delivery to each |
| `removeMemberEndpoint(owner, id)` | Removes the endpoint when the member owns it |
| `removeMemberEndpoints(owner)` | Removes every endpoint of the member, such as when they disconnect their agents |
| `disableMemberEndpoint(id, { by })` | Stops sends to the endpoint. `by` names who did it. Check that the caller is an admin first. |
| `enableMemberEndpoint(id)` | Starts sends to a disabled endpoint again |

Each returns `[error, data]`. An endpoint has `id`, `owner`, `ownerName`, `ownerEmail`, `name`, `address`, `kind`, `agent`, `host`, `disabledAt`, `disabledBy`, `createdAt`, and `updatedAt`. It never holds the receiver URL or the secret.

## In the Console

The **Webhooks** section of the [Console](/docs/console) lists the member endpoints for admins, read-only: the owner, the agent, the host, and the last result, such as `202` or `401, 3 in a row`. Admins cannot create or edit an endpoint, and never see its URL or secret. They can **Disable** one, which stops its sends, and **Enable** it again. The delivery log filters by owner and by endpoint.

`vitehub webhooks endpoints`, `vitehub webhooks disable-endpoint <id>`, and `vitehub webhooks enable-endpoint <id>` do the same from the CLI, and `vitehub webhooks deliveries --owner <id>` lists the deliveries of one member.

The endpoint list returns up to 500 rows per page. To get the next page, pass the last row's `createdAt` and `id`, for example `vitehub webhooks endpoints --after '{"createdAt":1794400000000,"id":"whe_123"}'`. Use `--limit` for a smaller page. The owner filter includes deliveries from earlier endpoints, even after reconnecting.

## Who owns an endpoint

Only the member who owns an endpoint can send to it again: **Redeliver** and **Send now** of a member delivery work for the owner, and everyone else gets `403` with [`WEBHOOKS_DELIVERY_NOT_OWNER`](/docs/webhooks/diagnostics/webhooks_delivery_not_owner). The Console shows the buttons only on your own deliveries.

| Caller | Owns the endpoint when |
| --- | --- |
| An app user, such as through the app's MCP | Its user id is `owner` |
| A ViteHub Console account | Its verified email equals `ownerEmail` and the app's Auth still verifies that email for `owner` |
| The CLI with a key | Never: a key names no person |

Console accounts are not app users, so their ids never match `owner`. If the app cannot verify the current owner, only the app user can redeliver. After changing their email, a member can reconnect the endpoint to use Redeliver from the Console again.

In server code, pass the caller: `redeliverWebhookDelivery(id, { caller: { id: user.id } })` from `vite-hub/webhooks/runtime`.

::details{summary="Turn on member endpoints from a Vite plugin"}
A package that sends to members turns member endpoints on from its Vite plugin with `vitehub.webhooks`. Webhooks then adds the table and installs the endpoint store, with no `server/webhooks/` files and no Queue:

```ts [my-send/vite.ts]
export function mySend() {
  return {
    name: 'my-send',
    vitehub: { webhooks: { memberEndpoints: true, reason: 'Sends waiting comments to each member\'s agent.' } },
  }
}
```

The app adds `mySend()` to its Vite plugins next to `vitehub({ database: true })`.

`vitehub.webhooks` can also be a function that gets the project roots and the sibling plugins, and returns `undefined` when the feature is off. Without `database`, the build fails with [`WEBHOOKS_DATABASE_OFF`](/docs/webhooks/diagnostics/webhooks_database_off) and names the plugin.
::
