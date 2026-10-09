# @vite-hub/connections

`@vite-hub/connections` stores one OAuth grant or API key per Connection and lets server code call the provider API with typed methods. Each call applies the Connection access rules, can wait for approval, and is recorded as Env Bridge activity. Application code never reads the token.

Install this owner package alongside `vite-hub` and use `@vite-hub/connections` imports. The owner plugin provides Connection discovery and management for Vite applications.

## Install the owner package

```sh
pnpm add @vite-hub/connections drizzle-orm
```

The package requires Node.js 24 or newer. Vite is an optional peer and is needed only for Connection Definition discovery. The default store needs `drizzle-orm` and a SQLite Drizzle database.

## Define a Connection

```ts
// server/connections/google.ts
import { defineConnection } from "@vite-hub/connections";
import { google } from "@vite-hub/connections/google";

export default defineConnection({
  provider: google({
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  }),
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  api: { gmail: ["users.labels.*", "users.messages.list", "users.messages.modify"] },
  access: {
    "schedule:gmail": { read: true, write: ["gmail.users.messages.modify"] },
    "agent:labeller": { read: true, write: "approve" },
  },
});
```

Connection names may include punctuation, spaces, Unicode, and nested paths. They must not exceed 501 characters, including path separators, so the default Env key fits its 512-character limit.

## Call the API

```ts
import { useConnection } from "@vite-hub/connections/server";

const gmail = useConnection("google", { actor: "schedule:gmail" }).gmail;
const { labels = [] } = await gmail.users.labels.list({ userId: "me" });
```

Server code cannot pass an `agent:` actor. That call fails with `CONNECTION_INVALID`. An Agent actor comes only from the Env access context that the ViteHub Agent runtime creates for the Agent Definition that runs. Agents call Connections through their Connection capabilities, for example `gmail()`, `mcp()`, and `openapi()`.

The client exposes only the methods selected in `api`. GET, HEAD, and OPTIONS methods are reads and other methods are writes. Denied calls throw `ConnectionError` with code `CONNECTION_DENIED`. Dry-run clients keep read responses non-optional; only skipped writes add `undefined` to the result. Custom typed catalogs can include a `method` field in each method signature to preserve this distinction. Writes that need approval throw `CONNECTION_APPROVAL_REQUIRED` and create an approval.

Typed catalog methods and `useConnection().fetch()` can send the Connection token only to provider catalog origins or declared API key origins. A catalog path or reserved path parameter that resolves to another origin fails with `CONNECTION_INVALID` before a provider call or approval is created. `ConnectionFetchInit` accepts `method`, `headers`, `redirect`, `signal`, and a string `body` for approval replay. `useConnection(name, { rejectApprovals: true })` rejects approval-gated calls with `CONNECTION_DENIED` without storing a replay request. Use it for protocols that need the response in the active session, such as MCP. It does not bypass access policy. Encode form parameters with `URLSearchParams.toString()` and set the form content type.

## Use an API key

Use `apiKey()` when the provider gives a static key instead of OAuth. An admin sets the key at runtime, so it never appears in code or Server Env:

```ts
// server/connections/executor.ts
import { apiKey, defineConnection } from "@vite-hub/connections";

export default defineConnection({
  provider: apiKey({ id: "executor", origins: ["https://executor.sh"] }),
  access: { "agent:support": { read: true, write: ["fetch"] } },
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `origins` | required | Origins that `fetch` may send the key to. Use `https`, or `http` for a loopback host. API catalog root URLs in `apis` also receive the key. |
| `header` | `authorization` | Request header that carries the key. |
| `scheme` | `Bearer` for `authorization`, none for other headers | Text before the key. Set `""` to send the bare key. |
| `apis` | `{}` | Typed API catalogs, as for OAuth providers. |
| `verify` | none | Check a new key before it is stored. It receives the runtime `fetch` and a 30-second abort signal. Return `false` to reject the key, or `{ account }` to label the Connection. |
| `id` | `"api-key"` | Provider id in inspection and the Console. |

Set the key in the Console with **Set key**, or pipe it to the CLI. The CLI reads the key only from stdin and sends it only over HTTPS or to a loopback host:

```sh
printf %s "$EXECUTOR_API_KEY" | vitehub connections set-key executor
```

ViteHub seals the key like an OAuth token, and access rules, approvals, dry run, and activity work the same way. An API key has no scopes and no refresh: a `401` response does not change the Connection status. When a redirect leaves the first origin, ViteHub removes the key header. Revoking an API key Connection deletes the stored key. Revoke the key at the provider too.

## Use a custom store

`useConnection()` uses the ViteHub Database and `VITEHUB_CONNECTIONS_KEY` by default. Call `setConnectionsRuntime()` to use another database or key:

```ts
import { createDatabaseConnectionStore, setConnectionsRuntime } from "@vite-hub/connections/server";

setConnectionsRuntime({
  definitions: { google: () => import("./server/connections/google.ts") },
  store: createDatabaseConnectionStore({ db, encryptionKey }),
});
```

Rejected or superseded OAuth callbacks do not revoke their issued token at the provider. A provider can revoke the whole application grant, which would also invalidate the winning token. The rejected token is not stored. A successful exchange that cannot be accepted locally quarantines the current Connection and retains its mutation lease, including a different or unidentified replacement account. Confirm the provider outcome and repair that lease before revoking or connecting again.

The default store serializes authorization-code exchange and persistence, token refresh, and provider revocation through one durable per-Connection mutation lease shared by all runtimes. Callback exchange waits until grant-wide revocation has finished. Waiting refresh callers read the replacement token instead of sending the same rotating grant again. Provider requests have a 30-second abort signal and a 60-second lease.

An expired unresolved lease blocks every token revision. A replacement token cannot prove that an earlier provider request has stopped. Confirm the provider outcome before repairing the lease in the application's store, then connect again. The default SQLite store exposes lease metadata in `vitehub_connection_refresh_leases`, with `name`, `owner`, `revision`, and `expires_at` columns. Inspect those columns without reading secrets. After confirming that the former operation can no longer affect the provider grant, remove only the matching `name` and `owner` row. Do not delete a lease solely because it expired. A request that settles normally releases its own lease.

Custom stores must implement atomic `refreshLeases.claim()` and owner-fenced `refreshLeases.release()`. The name remains for compatibility, but the lease covers all token mutations. `claim()` returns `acquired`, `busy`, or `expired`; it must never replace an expired unresolved lease, even when the token revision changed. A lost refresh response or failed token write requires reconnecting rather than reusing the old grant. An unconfirmed callback exchange or revoke keeps its lease until the provider outcome is confirmed and the store is repaired. A successful callback exchange stays fenced through account extraction and token/state persistence. Failures during those steps quarantine the current token revision as `reauth_required`.

A custom Connections store must supply the token revision as the second `bridge.use()` callback argument. Revocation requires a provider `revocationEndpoint` and uses that revision to replace the token with a revoked marker. A provider without that endpoint rejects revocation and keeps the stored grant. The default Env Bridge supplies it. Connections has no standing administrator access to its bridge. For each call, Env gives it a context for one Connection token and one permission.

## Vite integration

`hubConnections()` from `@vite-hub/connections/vite` discovers `server/connections/*.ts` and `*.connection.ts`, generates the registry and types, mounts the management API in development, and adds the `vitehub connections` CLI.

| Option | Default | Meaning |
| --- | --- | --- |
| `actor` | none | Module whose default export is the access policy of the management API, in development and production. `vite-hub` sets it to the Console actor module when the Console shows Connections. |
| `database` | `false` | Module that exports the SQLite Drizzle database as `db`. |
| `management` | `false` | Mount the management API in production. Production requires an actor module, from `actor` or `management: { actor }`. |
| `projectRoot` | Vite root | Project root for discovery. |

The actor module default-exports one of these policies:

- A function `(request, event) => string | undefined`. It authenticates the `Request` and returns `user:<id>` for an authorized manager, or `undefined` to reject the request (`403`). Relative module paths resolve from the project root.
- The string `"development"`. It allows every request as `user:local`, but only when `NODE_ENV` is `development`. Any other runtime returns `500` with `CONNECTION_AUTH_REQUIRED`.

Without an actor module, the development server uses `"development"`. A production build without an actor module fails.

With `vite-hub` and the Console, the policy is the Console access policy of the data routes. The Connections routes first run the same check, then name the manager:

| Console access | Check | Manager |
| --- | --- | --- |
| Console Auth (`console: { access: "auth", auth: { ... } }`) | The Console Auth session and its `authorize` callback. | The signed-in user, `user:<id>`. |
| Primary Auth (`console: { access: "auth" }` with an Auth Definition) | The app Auth access routes that protect the Console. | The signed-in user, `user:<id>`. |
| Cloudflare Access (`auth: { provider: "cloudflare-access" }`) | The Cloudflare Access token. | `user:cloudflare-access`. |
| `exposure: "host-managed"` | The host `console.authorize` function. | `user:host-managed`. |
| `console: true` | Development server only. Production returns `403`. | `user:local`. |

```ts
import { hubConnections } from "@vite-hub/connections/vite";

hubConnections({ management: { actor: "./server/connections-auth.ts" } });
```

### Management routes

`createConnectionsHandler({ actor, basePath, runtime })` from `@vite-hub/connections/http` serves these routes. `actor` is required.

| Route | Use |
| --- | --- |
| `POST /_vitehub/connections` | Run one JSON action, for example `list`, `revoke`, `set-key`, or `approve`. Same-origin JSON only. |
| `GET /_vitehub/connections/connect/:name` | Start the OAuth flow, set the `state` cookie, and redirect to the provider. Cross-site requests get `403`. |
| `GET /_vitehub/connections/callback` | Complete the OAuth flow. |

Every route runs the access policy itself, before the route body. Middleware, such as Console Auth, is an extra layer and not the only check. A route body gets the Connections runtime only from the access that the policy creates for the current request.

The OAuth callback is reached by a browser redirect from the provider. It completes the flow only when all of these are true:

- The `state` query value is equal to the `state` cookie that the start request set in this browser.
- The `state` is known and not expired. The store deletes it when the callback reads it, so a `state` works one time only.
- The access policy accepts the callback request, and returns the same manager that started the flow. A `state` that another manager started returns `403` and is consumed.

`runtime.complete({ actor, code, state })` applies the same manager check. `actor` defaults to `user:local`, as in `runtime.authorize()`.

## Generate API catalogs

`pnpm --dir packages/connections run generate` reads the Google Discovery document and writes `src/google/gmail.ts`.

See the [Connections documentation](https://vitehub.dev/docs/connections).

Connection stores must implement `state.putForToken(state, revision)` as an atomic write that succeeds only while the encrypted token has that revision. A `null` revision requires the token to be absent. OAuth, refresh, and revocation use this check so older work cannot replace newer Connection metadata.

An approved write that was sent to the provider can have an uncertain outcome after a lost response, a provider server error, or a local persistence failure. The runtime reports `CONNECTION_EXECUTION_UNKNOWN` and never replays that approval. Check the provider before requesting another approval. The management HTTP handler returns status 409 for this error.

After confirmed provider revocation, local recovery reads the current token revision. A persisted revoked marker restores `revoked` state. If the original token remains, recovery marks it `reauth_required` and retains its mutation fence. A newer replacement token is not changed.
