---
title: Console limits and errors
description: Fix a Console section that is missing, a call that returns 401 or 403, and every CONSOLE_ error code, and repair quarantined image uploads.
navigation.title: Limits and errors
navigation.order: 40
navigation.group: Reference
icon: i-lucide-circle-alert
---

Find the symptom first, then the `code` that the failed call returned.

## Fix common failures

| Symptom | Fix |
| --- | --- |
| A section is missing | Configure its primitive, such as `agent`, `kv`, `blob`, `database`, `rateLimit`, `workspace` or `sandboxTask`, in the same ViteHub configuration, and allow it in `authorize`. |
| A KV key list stops at 200 entries | Load the next page, or enter a key prefix. |
| KV or Blob inspection returns a provider error | Give the deployed app credentials that can read the store. |
| Agents has no sessions | Invoke a discovered Agent, and check that it uses the default or the app-wide `agent.invocations` journal. |
| Agent Console startup fails on a deployment host | The default SQLite journal needs a writable, persistent file system. Set `agent.invocations: 'database'`, or give every Agent one durable journal. |
| The Console cannot reach the app | Link it with the URL that serves it, on a public server. The Console cannot reach `vite dev` on your machine. |
| The build fails with `VITE_HUB_B0020` and names a `console` option | The option is removed. Follow the fix in the message, or see [Move from earlier releases](/docs/console/migrate). |
| `console.impersonation` fails with `VITE_HUB_B0005` | Set `auth: true` and add an Auth Definition with Better Auth's `admin` plugin, such as `server/auth.ts`. |
| The server warns that `auth: false` takes unsigned calls | Remove `console.auth`, and set a `VITEHUB_CONSOLE_KEY_<NAME>` variable. |
| Console routes return `500` with "console.authorize must return" | Return `true`, `false`, a global `Response`, or `{ sections: string[] }` from `authorize`. |
| A call returns `401` | Sign the request. The `code` says what is wrong. |
| A call returns `403` | `authorize` rejected the caller, or returned `{ sections }` without that section id. |

## Error codes

A failed request returns JSON with a stable `code`, a `message`, a `fix` and a `docs` link, plus `ok: false` and `status` from the RPC. A route with its own diagnostic, such as `VITE_HUB_R0114`, keeps that code.

| Code | Status | Fix |
| --- | --- | --- |
| `CONSOLE_ACCESS_DENIED` | `403` | Use an account or a key that `authorize` allows. |
| `CONSOLE_IMPERSONATING` | `403` | The caller uses an impersonation session. Stop impersonating to get your own session back. |
| `CONSOLE_DEVELOPMENT_ONLY` | `403` | Rebuild and deploy with a `console` option, and set `console.authorize` to restrict who may use it. |
| `CONSOLE_LOOPBACK_ONLY` | `403` | The dev server takes unsigned calls from this machine only. See [Share a development server](/docs/console/development#share-a-development-server). |
| `CONSOLE_ORIGIN_REJECTED` | `403` | Call from the app origin, or send `x-vitehub-console: 1` with no `Origin`. |
| `CONSOLE_SIGNATURE_MISSING` | `401` | Open the app from the ViteHub Console, or set `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` for the CLI. See [Signed requests](/docs/console/signed-requests). |
| `CONSOLE_SIGNATURE_STALE` | `401` | Sync the clock of the machine that signs. |
| `CONSOLE_SIGNATURE_ORIGIN` | `401` | Link the app with the URL that serves it. Behind a proxy that ends TLS, set `vitehub({ publicUrl })`. |
| `CONSOLE_SIGNATURE_INVALID` | `401` | Sign with the private key whose public key is in the `VITEHUB_CONSOLE_KEY_<NAME>` that the signature names. |
| `CONSOLE_SIGNATURE_BODY` | `401` | Send the body that the signature covers, through a proxy that does not change it. |
| `CONSOLE_TICKET_INVALID` | `401` | Open the page again from the Console. A [one-time link](/docs/console/site-access#one-time-links) works once, within 60 seconds. |
| `CONSOLE_TICKET_MISMATCH` | `403` | Open the link in a browser that is signed in to the app with the email of your Console account. |
| `CONSOLE_TICKET_STORE_MISSING` | `500` | Add app Auth with a Database, so every instance shares the tickets. |
| `CONSOLE_KEY_UNKNOWN` | `401` | Set the `VITEHUB_CONSOLE_KEY_<NAME>` line from the Console setup page or `vitehub secret console-key`, then restart or deploy. |
| `CONSOLE_KEY_NOT_CONFIGURED` | `500` | Set a `VITEHUB_CONSOLE_KEY_<NAME>` variable, then restart or deploy. |
| `CONSOLE_KEY_MALFORMED` | `500` | Set the 43 base64url characters of the public key, with no quotes or spaces, then restart or deploy. |
| `CONSOLE_ACCESS_NOT_CONFIGURED` | `500` | Build the app with the ViteHub plugin. |
| `CONSOLE_AUTHORIZE_REQUIRED` | `500` | Set `console.authorize`. |
| `CONSOLE_REQUEST_INVALID` | `400`, `405`, `413` | Check the request body, and update `vite-hub` in the app when the Console is newer. |
| `CONSOLE_NOT_FOUND` | `404` | Reload the Console. |
| `CONSOLE_CONFLICT` | `409` | Reload, then try again. |
| `CONSOLE_UNAVAILABLE` | `408`, `429`, `502` to `504` | Wait, then try again. |
| `CONSOLE_REQUEST_FAILED` | `500` | Try again, then read the server logs. |
| `CONSOLE_MCP_UNREACHABLE` | `502` | Check that the MCP server runs and that the URL is its Streamable HTTP endpoint, such as `/mcp`. |
| `CONSOLE_MCP_SIGNED_OUT` | `409` | Sign in again, or connect again with a new token. |
| `CONSOLE_MCP_AUTHORIZATION_FAILED` | `400`, `404`, `409`, `502` | Start the sign-in again. The server must publish RFC 9728 metadata that names an authorization server with client registration. |
| `CONSOLE_MCP_KEY_INVALID` | `500` | Set `VITEHUB_CONSOLE_MCP_KEY` to 32 random bytes as base64 or hex, such as the output of `openssl rand -base64 32`. |
| `CONSOLE_MCP_KV_REQUIRED` | `500` | Turn on the default KV store with `kv: true` or an explicit default KV configuration, then rebuild. |

## Repair quarantined image uploads

Before each image upload, the Console retries up to 100 pending rollback records in the Blob store and moves malformed batch records, unchanged, to `_vitehub/console/quarantine/batch/<id>`. Uploads continue and no image bytes are deleted, but stored attachment references stay unavailable while any quarantine record exists, because the Console cannot tell which upload owns them.

To repair a record, write its original attachment UUIDs, from trusted storage history, as a JSON array of 1 to 10 to `_vitehub/console/cleanup/batch/<id>`, or `vitehub-console-attachment-cleanup/<id>` for a legacy record. Once a later upload drains it, delete the quarantine object through the Blob provider.

::warning
If you cannot get the original UUIDs, keep the quarantine record. A guess can delete images that you meant to keep.
::
