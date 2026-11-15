---
title: Connections limits and errors
description: Know how Connections store and encrypt grants, how the OAuth connect flow is secured, and which error codes it returns.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Storage and security

- Grants are encrypted with AES-GCM and the encryption key. Each row stores the key id. With a different key, the status is `needs-reconnect`.
- The connect flow uses PKCE (`S256`), a one-time ticket that expires after 10 minutes, and a `state` cookie. Tokens never go to the browser or the CLI.
- Connect, callback, and management routes exist in dev, and in production only with `connections: { management: { actor } }`. Each route checks the `actor` policy of the app. See [Management routes](/docs/connections/server-api#management-routes).
- The OAuth callback accepts a `state` once, only from the browser and manager that started the flow.
- The routes keep the Vite `base` in management, connect, callback, and return URLs.
- A database lease lets only one request refresh a rotating refresh token.

## Errors

Management routes return `{ error: { code, message, fix, docs } }`. `message` says why the request failed, `fix` says how to repair it, and `docs` links here. The connect and callback routes show the same on their HTML page.

### CONNECTIONS_APPROVAL_REQUIRED

The action needs approval.

### CONNECTIONS_AUTHORIZATION_EXPIRED

The callback carried a `state` that the server does not know. Each link works once, for 10 minutes, so the sign-in took longer, the link was used, or the server lost the pending sign-in. `vitehub connections connect` waits 10 minutes and prints the expiry. Run it again, and finish in time.

### CONNECTIONS_AUTHORIZATION_CANCELLED

The provider did not grant access.

### CONNECTIONS_AUTH_REQUIRED

Management needs Auth outside local dev. A host that calls `createConnectionsHandler()` itself also gets this code when it passes no actor policy.

### CONNECTIONS_CONTENT_TYPE_REJECTED

Send `application/json`.

### CONNECTIONS_DENIED

Access rules deny this actor.

### CONNECTIONS_EXECUTION_UNKNOWN

The provider may have done the write. Check before you retry.

### CONNECTIONS_FORBIDDEN

No allowed manager is signed in, or the authorization belongs to another actor. A ChatGPT credential export or import also gets this code over HTTP on a host that is not loopback: use HTTPS.

### CONNECTIONS_INVALID_ACTOR

Pass `user:<id>` or `service:<id>`. The runtime methods `approve`, `deny`, `authorize`, `complete`, `revoke`, and `setKey` require `actor` and have no default.

### CONNECTIONS_INVALID_APPROVAL

The approval is stale. Request again.

### CONNECTIONS_INVALID_CONFIG

Bad `basePath` or `activityRetention`.

### CONNECTIONS_INVALID_DEFINITION

The Connection Definition is invalid.

### CONNECTIONS_INVALID_INPUT

A parameter is missing, or a body is not a string.

### CONNECTIONS_INVALID_NAME

The name is too long or padded.

### CONNECTIONS_INVALID_PROVIDER

The provider options are invalid.

### CONNECTIONS_INVALID_REQUEST

The request does not fit the Connection state.

### CONNECTIONS_INVALID_STORED_DATA

Stored data is invalid. Connect again.

### CONNECTIONS_KEY_REJECTED

The provider rejected the key.

### CONNECTIONS_METHOD_NOT_ALLOWED

Use the method in `Allow`.

### CONNECTIONS_NEEDS_RECONNECT

Connect the Connection again.

### CONNECTIONS_NOT_CONFIGURED

`VITEHUB_CONNECTIONS_KEY` or the Database is missing. A custom store without atomic refresh leases or token revisions also gets this code on refresh and revoke.

### CONNECTIONS_NOT_CONNECTED

The Connection is not connected.

### CONNECTIONS_NOT_FOUND

No Connection has this name.

### CONNECTIONS_ORIGIN_NOT_ALLOWED

The origin is not allowed. No credential was sent.

### CONNECTIONS_ORIGIN_REJECTED

The browser origin does not match. Behind a proxy, set `vitehub({ publicUrl })`.

### CONNECTIONS_PROVIDER_FAILED

The provider rejected the request.

### CONNECTIONS_REQUEST_FAILED

Read the server logs.

### CONNECTIONS_ROUTE_NOT_FOUND

Check the path and Vite `base`.

### CONNECTIONS_STATE_CONFLICT

The token, key, or account changed. Try again.

### CONNECTIONS_STATE_MISMATCH

The `state` cookie is missing or wrong. Start again.

### CONNECTIONS_UNAVAILABLE

Another request changes the token. Retry soon.

### CONNECTIONS_UNKNOWN_ACTION

The API has no such method.

### CONNECTIONS_CHATGPT_IDENTITY

The ID token failed the signature, issuer, audience, expiry, nonce, or account check. Run `vitehub connections connect <name>` again.

### CONNECTIONS_CHATGPT_REGISTRATION

The callback client ID differs from the pending registration. Sign in again. Keep each client ID with its account and host.

### CONNECTIONS_CHATGPT_LOOPBACK

Plan usage needs an HTTP callback on `127.0.0.1`. Run the CLI on the computer with your browser. For a VM, export the credential file, move it, and import it there.

### CONNECTIONS_CHATGPT_PERMISSION

The grant lacks plan scopes. Connect again and allow plan usage. ViteHub does not fall back to an API key.

### CONNECTIONS_CHATGPT_CLIENT

App code cannot use a ChatGPT grant with `useConnection().fetch()` or `.call()`. Set the Codex Driver gateway to `chatgpt()` from `vite-hub/gateways`.

### CONNECTIONS_CHATGPT_TRANSFER

The transfer file is invalid, or the target already has an active or different account. Export a new file and import it into a disconnected Connection of the same account. Keep the file private.
