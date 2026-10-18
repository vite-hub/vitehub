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
- Connect, callback, and management routes exist on the development server, and in production only with `connections: { management: true }`. Each route runs the Console access policy itself: Console Auth, app Auth, Cloudflare Access, or `auth: false`, then `console.authorize` when it is set. See [Management routes](/docs/connections/server-api#management-routes).
- The OAuth callback accepts a `state` one time only, from the browser and the manager that started the flow.
- The Console preserves the Vite `base` in management, connect, callback, and return URLs.
- Concurrent refreshes use a database lease, so only one request refreshes a rotating refresh token.

## Errors

Management routes return `{ error: { code, message, fix, docs } }`. The connect and callback routes show the same code, fix, and docs link on their HTML page. `message` says why the request failed, `fix` says how to repair it, and `docs` links the page that explains the code.

### CONNECTIONS_APPROVAL_REQUIRED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_AUTHORIZATION_CANCELLED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_AUTH_REQUIRED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_CONTENT_TYPE_REJECTED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_DENIED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_EXECUTION_UNKNOWN

See the `why` and `fix` fields in the error response.

### CONNECTIONS_FORBIDDEN

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_ACTOR

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_APPROVAL

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_CONFIG

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_DEFINITION

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_INPUT

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_NAME

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_PROVIDER

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_REQUEST

See the `why` and `fix` fields in the error response.

### CONNECTIONS_INVALID_STORED_DATA

See the `why` and `fix` fields in the error response.

### CONNECTIONS_KEY_REJECTED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_METHOD_NOT_ALLOWED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_NEEDS_RECONNECT

See the `why` and `fix` fields in the error response.

### CONNECTIONS_NOT_CONFIGURED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_NOT_CONNECTED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_NOT_FOUND

See the `why` and `fix` fields in the error response.

### CONNECTIONS_ORIGIN_NOT_ALLOWED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_ORIGIN_REJECTED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_PROVIDER_FAILED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_REQUEST_FAILED

See the `why` and `fix` fields in the error response.

### CONNECTIONS_ROUTE_NOT_FOUND

See the `why` and `fix` fields in the error response.

### CONNECTIONS_STATE_CONFLICT

See the `why` and `fix` fields in the error response.

### CONNECTIONS_STATE_MISMATCH

See the `why` and `fix` fields in the error response.

### CONNECTIONS_UNAVAILABLE

See the `why` and `fix` fields in the error response.

### CONNECTIONS_UNKNOWN_ACTION

See the `why` and `fix` fields in the error response.

When you change the provider of a Connection, the stored grant belongs to the old provider. The status becomes `needs-reconnect` with `lastError: 'CONNECTIONS_PROVIDER_CHANGED'`, and ViteHub never sends that grant to the new provider. Reconnect the Connection.
