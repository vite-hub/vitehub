---
title: Auth limits and errors
description: Check Auth before production, handle missing sessions in routes, and look up Auth error codes.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Production checks

- Read a strong Better Auth secret from Server Env at request time. Never put it in Public Env, client code, Agent input, logs, or traces.
- Set a request-aware `baseURL`, use `requestOrigin`, or set `vitehub({ publicUrl })`, so callback and cookie origins match the deployed host. Behind a proxy that ends TLS, also set [`advanced.trustedProxyHeaders`](/docs/auth/configure#behind-a-proxy-that-ends-tls).
- Store users and sessions: use [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database) and apply its migration, use another Better Auth database adapter, or use [`stateless()`](/docs/auth/configure#sessions-without-a-database) for social sign-in without a database.
- Protect app pages, APIs, and the Console endpoint yourself. A session proves who the user is. Your `authorize` callbacks define roles and permissions.
- Keep the automatic `/api/auth/**` route unless the host mounts the handler itself. Use the same `basePath` on server and client.
- A stateless session (no Better Auth `database` or `secondaryStorage` adapter) cannot use [`session.onRefresh`](/docs/auth/configure#session-refresh). Better Auth refreshes its cookie cache without a hook, so a banned user keeps the session until it expires.

## Handle required authentication

When a required session is missing, `authenticated()` throws `ViteHubError` with code `AUTHENTICATION_REQUIRED`. HTTP adapters turn it into `401`. The error serializes only its public message, without cause or stack.

```ts
import { ViteHubError } from 'vite-hub/runtime'

const error = new ViteHubError('AUTHENTICATION_REQUIRED', 'Sign in to use this Agent.')

console.log(error.toJSON())
```

| Code | When |
| --- | --- |
| `AUTHENTICATION_REQUIRED` | `authenticated()` requires a session and none exists. |
| `AUTH_PROVIDER_OPERATION_FAILED` | A default Better Auth request, session, or user lookup fails. `details.operation` is `get-auth-for-request`, `get-session`, or `get-user` (from `agentAuth.user()`). Raw provider details stay in `cause`. |
| `AUTH_C0041` | `session.onRefresh` is not a function. |
| `AUTH_C0042` | `session.onRefresh` is set, but Better Auth has no `database` or `secondaryStorage` adapter. |
| `AUTH_C0043` to `AUTH_C0049` | `preset` is not a preset, a `stateless()` combination fails, or `stateless({ maxAge })` is not a positive duration. See [Sessions without a database](/docs/auth/configure#sessions-without-a-database). |
| `AUTH_C0051` | `VITEHUB_ADMINS` is set, but `plugins` has no `admin()` to store the role. See [Give the first admin role](/docs/auth/configure#give-the-first-admin-role). |
| `AUTH_C0052` | `authDatabase()` gets a name that is not one inline string literal. |
| `AUTH_C0053` | `authDatabase()` needs text IDs from Better Auth or a custom function. `serial`, `uuid`, and `false` need another adapter and schema. |
| `AUTH_C0054` | `authDatabase()` needs one fixed Database target. Use one unconditional inline call, and keep the Database out of runtime overrides. |
| `AUTH_C0055` | `authDatabase()` has fixed core columns. For `additionalFields` on `user`, `session`, `account`, or `verification`, use another Better Auth adapter and a schema with the fields. |
| `AUTH_C0056` | A plugin adds unsupported columns to an Auth table, or a model or field mapping changes its fixed names. Use another Better Auth adapter and a matching schema. |
| `AUTH_C0057` | `VITEHUB_ADMIN_EMAILS` is set. It is removed: list the admin's social account in `VITEHUB_ADMINS`. |
| `AUTH_C0058` | A `VITEHUB_ADMINS` entry is an email, has no provider or account id, or is a GitHub login instead of the numeric id. |
| `AUTH_C0059` | `VITEHUB_ADMIN_CLAIM` is not `sha256:` and 64 hex characters. Set the value that `vitehub auth claim` prints, never the code. |
| `AUTH_C0060` | Both `shared/abilities.ts` and another `shared/abilities.*` file exist. Keep one. |
| `AUTH_R0019` | `authDatabase()` finds no Better Auth tables. Write the call inline in `defineAuth()`, turn on the Database integration, and run `vitehub database generate`. |
| `AUTH_R0020` | A check names an ability that `shared/abilities.ts` does not define. |
| `AUTH_R0021` | An ability rule returned a Promise. Rules also run in the browser, so load the data first and pass it to the rule. |
| `AUTH_C####`, `AUTH_B####`, `AUTH_R####` | Missing APIs, malformed responses, and invalid Auth Definitions, `authenticated()` config, or custom callback results. |

Existing ViteHub errors and structural `AbortError` objects keep their identity.

## Read a refusal

The guards refuse a request with one JSON body: `withAuth()`, `withAuthorization()`, `withAnonymousAuthorization()`, `requireAuth()`, `requireAuthorization()`, and the checks of `access.routes`. The body uses H3's error format, so a returned refusal and a thrown H3 error have the same `status`, `statusText`, `message`, and `data`. Nitro and Nuxt add `error: true` to a thrown error, and a stack in development.

```json
{ "status": 401, "statusText": "Unauthorized", "message": "Unauthorized.", "data": { "code": "SIGNED_OUT" } }
```

| `data.code` | Status | When |
| --- | --- | --- |
| [`SIGNED_OUT`](#signed_out) | `401` | The request has no Auth Session. |
| [`FORBIDDEN`](#forbidden) | `403` | The caller is signed in, but `authorize` does not return `true`. |

Read the code, not the message, in client code. The message can change.

```ts [app/utils/delete-post.ts]
export async function deletePost(id: string): Promise<'deleted' | 'sign-in' | 'forbidden'> {
  const response = await fetch(`/api/posts/${id}`, { method: 'DELETE' })
  if (response.ok) return 'deleted'
  const body: { data?: { code?: string } } = await response.json()
  if (body.data?.code === 'SIGNED_OUT') return 'sign-in'
  if (body.data?.code === 'FORBIDDEN') return 'forbidden'
  throw new Error(`Delete failed with HTTP ${response.status}.`)
}
```

- An HTML `GET` that `withAuth()` or an access route refuses still gets the `access.signIn` redirect. When `withAuthorization()` or an access route refuses it with `403`, it gets the text `Forbidden.`. `requireAuth()` and `requireAuthorization()` still put the code in `data` of their error.
- A `Response` that `authorize` returns goes to the client as it is, without a code.

## SIGNED_OUT

The request has no Auth Session, or the session ended. Sign in, then send the request again with the session cookie. A `fetch()` from another origin must send `credentials: 'include'`. After a failed sign-in, the URL has `auth_error`, and an HTML `GET` gets the text `403` `Unauthorized.` instead of a new redirect. `requireAuth()` then throws `403` with `SIGNED_OUT`.

## FORBIDDEN

The caller is signed in, but the `authorize` callback of the guard or the access route returned `false` or another value that is not `true`. An access route that has `authorize: true` in its route metadata also refuses when its callback is not there at runtime. Check the callback, or the roles of the user.

## AUTH_CONSOLE_INVALID_REQUEST

A field value, filter, or page size is not valid. Use the field type from `describe()` and a page size from 1 to 100.

## AUTH_CONSOLE_FORBIDDEN

App policy or the Better Auth session denies the action. `describe(request)` gives the reason. Console access does not give app admin rights.

## AUTH_CONSOLE_NOT_FOUND

The record or plugin is missing. Refresh the list and check the plugins in the Auth Definition.

## AUTH_CONSOLE_UNAVAILABLE

The operation needs a database adapter or plugin API. Add it to the primary Auth Definition.

## AUTH_CONSOLE_PROVIDER_FAILED

Better Auth or a computed column reader failed. Read the error cause in server code, and never send it to clients.

## AUTH_MCP_OAUTH_MISSING

`serveMcpOAuthDiscovery()`, `verifyMcpRequest()`, or `deleteUnusedMcpClients()` got an Auth whose plugins have no `oauthProvider()` with `resources`. Add `...mcpOAuth({ resource, loginPage })` from `vite-hub/auth/mcp` to the `plugins` of `defineAuth()`. See [Sign MCP clients in](/docs/auth/configure#sign-mcp-clients-in).

## AUTH_MCP_TOKEN_MISSING

`verifyMcpRequest()` got a request without an `Authorization: Bearer` header. Answer `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` so the MCP client starts the OAuth flow.

## AUTH_MCP_TOKEN_INVALID

The access token fails a check on its signature, issuer, audience (the resource), or expiry, or its user is gone or banned. It also fails on a path that is not a resource of `mcpOAuth()`, unless `verifyMcpRequest()` gets `resource`. Answer `401` with `error="invalid_token"` so the client signs in again.

## AUTH_MCP_CLEANUP_FAILED

`deleteUnusedMcpClients()` could not list or delete OAuth clients. Read the database error in `error.cause`, then run the cleanup again.
