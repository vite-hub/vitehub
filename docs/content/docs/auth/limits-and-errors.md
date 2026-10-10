---
title: Auth limits and errors
description: Check Auth before production and handle Auth error codes.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Production checks

- Supply a strong Better Auth secret from Server Env at request time. Never put it in Public Env, client code, Agent input, logs, or traces.
- Set a request-aware `baseURL`, use `requestOrigin`, or set `vitehub({ publicUrl })`, so callback and cookie origins match the deployed host.
- Configure a concrete Better Auth database adapter and its migrations.
- Protect application and Console pages and APIs explicitly. A session proves identity. Your `authorize` callbacks define roles and permissions.
- Keep automatic `/api/auth/**` exposure unless the host mounts the handler itself. Use the same `basePath` on the server and the client.

## Handle required authentication

`authenticated()` throws `ViteHubError` with code `AUTHENTICATION_REQUIRED` when a required Auth Session does not exist. HTTP adapters map that code to `401`. The error serializes its public message without its cause or stack.

```ts
import { ViteHubError } from '@vite-hub/runtime'

const error = new ViteHubError('AUTHENTICATION_REQUIRED', 'Sign in to use this Agent.')

console.log(error.toJSON())
```

| Code | When |
| --- | --- |
| `AUTHENTICATION_REQUIRED` | `authenticated()` requires a session and none exists. |
| `AUTH_PROVIDER_OPERATION_FAILED` | A default Better Auth request or session operation fails. Safe operation details are included. Raw provider diagnostics stay in `cause`. |
| `AUTH_C####`, `AUTH_B####`, `AUTH_R####` | Missing APIs, malformed responses, invalid Auth Definitions, invalid `authenticated()` configuration, and invalid custom callback results. |

Existing ViteHub errors and structural `AbortError` objects keep their identity.
