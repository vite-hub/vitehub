---
title: Connections
description: Connect an OAuth account once, then call its API from server code with typed methods, access rules, approvals, and activity.
navigation.order: 3.2
navigation.group: Application
icon: i-lucide-plug-zap
---

A Connection holds one OAuth grant for one provider account, for example a Google account for Gmail. Server code calls the provider API through the Connection. The Connection refreshes the token, checks the access rules, and records each call. Application code never reads the token.

Connections need the ViteHub [Database](/docs/server-primitives/database). Tokens are stored encrypted through [Env Bridge](/docs/server-primitives/env-bridge).

## Enable Connections

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    database: true,
    connections: true,
  })],
})
```

Set `VITEHUB_CONNECTIONS_KEY` to 32 random bytes in base64 or hex. Create one with `openssl rand -base64 32`. Keep the key in the host secret store. Tokens stored with one key cannot be read with another.

## Define a Connection

Put each definition in `server/connections/<name>.ts`, or in a `*.connection.ts` file. The file name is the Connection name.

```ts [server/connections/google.ts]
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  }),
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  api: {
    gmail: ['users.labels.*', 'users.messages.list', 'users.messages.get', 'users.messages.modify'],
  },
  access: {
    'schedule:gmail': { read: true, write: ['gmail.users.messages.modify'] },
    'agent:labeller': { read: true, write: 'approve' },
  },
})
```

| Field | Meaning |
| --- | --- |
| `provider` | The OAuth provider and its API catalogs. |
| `scopes` | Scopes to request. Inspection reports declared scopes that the grant does not have. |
| `api` | Methods to expose for each API. A trailing `.*` selects a subtree. Omit it to expose every method. |
| `access` | Access rules by actor. Omit it to use the default policy. |

Create the Google OAuth client as a **Web application**. Add each redirect URI that you use:

- `http://127.0.0.1:<port>/callback` for `vitehub connections connect --port <port>`.
- `https://<your-app>/_vitehub/connections/callback` for Console connect.

Google refresh tokens expire after 7 days while the OAuth consent screen is in **Testing** mode. Gmail scopes such as `gmail.modify` are restricted scopes. Publishing an app that uses them for other people needs Google verification.

## Connect an account

Start the development server, then run:

```sh
vitehub connections connect google --port 8976
```

The command prints the provider URL. Open it, grant access, and the loopback callback stores the token. A Connection has one account. To change the account, revoke the Connection first.

The development server mounts the management API at `/_vitehub/connections`. Production builds mount it only with `connections: { management: true }`. This option requires Console production access, `console: { access: 'auth' }` or `console: { exposure: 'host-managed' }`, because that access protects every `/_vitehub/**` route. Then open `https://<your-app>/_vitehub/connections/connect/google` while you are signed in to the Console. `vitehub connections connect google --url https://<your-app>` prints that URL.

With the Console enabled, open **Connections** in the Console and select **Connect** or **Reconnect**. The same page shows activity, decides approvals, and revokes a Connection. When Console auth is active, these actions record the signed-in Console user as `user:<id>`. See [Console](/docs/development/console#manage-connections).

## Call the API

```ts [server/tasks/label.ts]
import { useConnection } from 'vite-hub/connections/server'

const gmail = useConnection('google', { actor: 'schedule:gmail' }).gmail

const { messages = [] } = await gmail.users.messages.list({ userId: 'me', q: 'is:unread' })
for (const message of messages) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: message.id!,
    requestBody: { addLabelIds: ['Label_1'] },
  })
}
```

Method inputs and responses come from the provider API description. Only methods selected in `api` exist on the client. Path parameters and query parameters are fields of the input. The JSON body is `requestBody`.

`fetch()` calls a URL on a catalog origin with the Connection token. Use it for endpoints that the catalog does not describe. The token is never sent to another origin.

```ts
const response = await useConnection('google').fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile')
```

## Control access

The actor comes from `useConnection(name, { actor })`. It defaults to `server`. Use a stable name for each caller, for example `schedule:gmail` or `agent:labeller`.

GET methods are reads. Other methods are writes. Providers mark some writes as high risk, for example `gmail.users.messages.send`. A rule must name a high-risk write exactly. A subtree pattern does not match it.

Without `access`:

- Every actor can read.
- Server code can call writes that are not high risk.
- `agent:` actors need approval for each write.
- High-risk writes and `fetch` writes are denied.

With `access`, actors that are not listed are denied.

| Rule | Effect |
| --- | --- |
| `read: true` | Allow reads. |
| `write: ['gmail.users.messages.modify']` | Allow these writes. Patterns can end with `.*`. |
| `write: true` | Allow every write that is not high risk. |
| `write: 'approve'` | Allow writes that are not high risk after approval. |
| `approve: true` | Require approval for each allowed write. It defaults to `true` for `agent:` actors. |

Name `fetch` in `write` to allow `fetch()` writes.

A denied call throws `ConnectionError` with code `CONNECTION_DENIED` and records a `denied` activity entry.

## Approve writes

A write that needs approval throws `ConnectionError` with code `CONNECTION_APPROVAL_REQUIRED`. `error.requestId` is the approval id. The approval stores the method and its input.

```sh
vitehub connections approvals --json
vitehub connections approvals --before approval_older_page...
vitehub connections approvals approve approval_3kq2...
vitehub connections approvals deny approval_3kq2...
```

Approval lists return at most 100 rows. JSON output has `{ approvals, nextCursor? }`. Pass `nextCursor` to `--before` with the same name and status filters to read older approvals. The Console provides Previous and Next controls for pending approvals and uses grouped pending counts for its Connections list.

Approving runs the call once, as the actor that requested it. The access rules still apply. The approval then has status `executed` or `failed`.

## Preview writes

With `dryRun: true`, reads run and writes are skipped. Each skipped write is reported to `onEffect`. The method resolves to `undefined`. Denied writes still throw.

```ts
const effects: ConnectionEffect[] = []
const gmail = useConnection('google', {
  actor: 'schedule:gmail',
  dryRun: true,
  onEffect: effect => effects.push(effect),
}).gmail
```

## Inspect activity

Each call is an Env Bridge `use` operation on the key `connection/<name>`. Activity records the actor, the action id, the outcome, and optional `traceId` and `invocationId`. It does not record inputs, responses, or tokens.

```sh
vitehub connections list
vitehub connections inspect google
vitehub connections activity google
```

## Tokens and errors

The Connection refreshes the access token when it expires within 60 seconds, and once after a `401` response. Concurrent refreshes in one runtime share one token request. When two runtimes refresh at the same time, the conditional write fails for one of them, and that runtime uses the stored token.

| Code | Meaning |
| --- | --- |
| `CONNECTION_REAUTH_REQUIRED` | The Connection is not connected, was revoked, or the provider rejected the refresh token. Connect it again. |
| `CONNECTION_DENIED` | The access rules deny the call. |
| `CONNECTION_APPROVAL_REQUIRED` | The call waits for approval. |
| `CONNECTION_PROVIDER` | The provider returned an error. `error.status` is the HTTP status. |
| `CONNECTION_INVALID` | The request or configuration is invalid. |

`vitehub connections revoke google --confirm google` revokes the grant at the provider and replaces the stored token with a revoked marker.

## Limits

- The default store uses SQLite through the ViteHub Database.
- One account per Connection.
- The built-in provider is Google with the Gmail API.
- The CLI uses the management API. It cannot reach a deployed app that requires host authentication, such as Cloudflare Access. Use Console connect for deployed apps.
