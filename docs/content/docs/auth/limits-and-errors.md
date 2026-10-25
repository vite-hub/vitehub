---
title: Auth limits and errors
description: Check Auth before production, handle required authentication in routes, and read the stable Auth error codes.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Production checks

- Supply a strong Better Auth secret from Server Env at request time. Never put it in Public Env, client code, Agent input, logs, or traces.
- Set a request-aware `baseURL`, use `requestOrigin`, or set `vitehub({ publicUrl })`, so callback and cookie origins match the deployed host.
- Configure a concrete Better Auth database adapter and its migrations, or use [`stateless()`](/docs/auth/configure#sessions-without-a-database) for social sign-in without a database.
- Protect application and Console pages and APIs explicitly. A session proves identity. Your `authorize` callbacks define roles and permissions.
- Keep automatic `/api/auth/**` exposure unless the host mounts the handler itself. Use the same `basePath` on the server and the client.
- A stateless session, without a Better Auth `database` or `secondaryStorage` adapter, cannot use [`session.onRefresh`](/docs/auth/configure#session-refresh). Better Auth refreshes its cookie cache without a hook, so a banned user keeps the session until it expires.

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
| `AUTH_PROVIDER_OPERATION_FAILED` | A default Better Auth request, session, or user lookup fails. `details.operation` is `get-auth-for-request`, `get-session`, or `get-user` (from `agentAuth.user()`). Raw provider diagnostics stay in `cause`. |
| `AUTH_C0041` | `session.onRefresh` is not a function. |
| `AUTH_C0042` | `session.onRefresh` is set, but Better Auth has no `database` or `secondaryStorage` adapter. |
| `AUTH_C0043` to `AUTH_C0049` | `preset` is not a preset, a `stateless()` combination fails, or `stateless({ maxAge })` is not a positive duration. See [Sessions without a database](/docs/auth/configure#sessions-without-a-database). |
| `AUTH_C####`, `AUTH_B####`, `AUTH_R####` | Missing APIs, malformed responses, invalid Auth Definitions, invalid `authenticated()` configuration, and invalid custom callback results. |

Existing ViteHub errors and structural `AbortError` objects keep their identity.

## AUTH_CONSOLE_INVALID_REQUEST

The request has an invalid field value, filter, or page size. Use the field type from `describe()` and a page size from 1 to 100.

## AUTH_CONSOLE_FORBIDDEN

App policy or the Better Auth session denies the action. Read `describe(request)` for the action reason. Console access does not grant app admin rights.

## AUTH_CONSOLE_NOT_FOUND

The record or plugin is unavailable. Refresh the list and check the Auth Definition's plugins.

## AUTH_CONSOLE_UNAVAILABLE

The operation needs a database adapter or plugin API. Configure them in the primary Auth Definition.

## AUTH_CONSOLE_PROVIDER_FAILED

Better Auth or a computed column reader failed. Inspect the error cause in server code. Do not send that cause to clients.
