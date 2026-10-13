---
title: Connections limits and errors
description: Connections storage, security guarantees, and error codes.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Storage and security

- Grants are sealed with AES-GCM and the encryption key. Each row stores the key id. With a different key, the status is `needs-reconnect`.
- The connect flow uses PKCE (`S256`), a single-use ticket that expires after 10 minutes, and a `state` cookie. Tokens never go to the browser or the CLI.
- Connect, callback, and management routes exist on the development server, and in production only with `connections: { management: true }`. Each route runs the Console access policy itself: Console Auth, app Auth, Cloudflare Access, or the host `console.authorize` function. With `console: true`, the routes work only on the development server. See [Management routes](/docs/connections/server-api#management-routes).
- The OAuth callback accepts a `state` one time only, from the browser and the manager that started the flow.
- The Console preserves the Vite `base` in management, connect, callback, and return URLs.
- Concurrent refreshes use a database lease, so only one request refreshes a rotating refresh token.

## Errors

| Code | Cause |
| --- | --- |
| `CONNECTIONS_NOT_CONFIGURED` | The database or the encryption key is missing. |
| `CONNECTIONS_INVALID` | The management or connect request is not valid, or the ticket or `state` does not match. |
| `CONNECTIONS_NOT_FOUND` | No Connection Definition has this name. |
| `CONNECTIONS_MISSING` | The Connection is not connected. |
| `CONNECTIONS_NEEDS_RECONNECT` | The provider rejected the refresh token. |
| `CONNECTIONS_KEY_MISMATCH` | The grant was sealed with a different key. |
| `CONNECTIONS_DENIED`, `CONNECTIONS_APPROVAL_REQUIRED` | Access rules blocked the call. |
| `CONNECTIONS_ORIGIN_NOT_ALLOWED` | The request URL is not in the provider `origins`. ViteHub did not send the credential. |
| `CONNECTIONS_PROVIDER_FAILED` | The provider returned an error. `details.status` has the HTTP status. |
| `CONNECTIONS_UNAVAILABLE` | Another request holds the refresh lease. Try again. |
| `CONNECTION_FORBIDDEN` | The management request has no authorized manager, or it is cross-origin. |
| `CONNECTION_AUTH_REQUIRED` | The management routes use the `'development'` policy and the server is not a development server. |

When you change the provider of a Connection, the stored grant belongs to the old provider. The status becomes `needs-reconnect` with `lastError: 'CONNECTIONS_PROVIDER_CHANGED'`, and ViteHub never sends that grant to the new provider. Reconnect the Connection.
