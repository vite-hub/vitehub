# @vite-hub/auth

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Better Auth" src="https://comark-ui.onmax.me/badge.svg?label=Better+Auth&amp;value=powered">
  <img alt="Vite" src="https://comark-ui.onmax.me/badge.svg?label=Vite&amp;value=discovery">
</p>

`@vite-hub/auth` defines one server-owned Auth Definition and turns it into a Better Auth server for ViteHub apps.

Most applications install `vite-hub` and enable Auth through the framework preset. Install this owner package directly when a focused Vite integration, library, or manual host needs Auth without the rest of ViteHub. Better Auth still owns providers, client plugins, adapters, and sign-in UI.

## Install

```sh
pnpm add @vite-hub/auth better-auth
pnpm add -D vite
```

## First local session

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth";

export default defineAuth({
  appName: "My app",
  emailAndPassword: { enabled: true },
});
```

```ts
// vite.config.ts
import { hubAuth } from "@vite-hub/auth/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubAuth()],
});
```

Start the Vite Development Server, then create a local session through the mounted Better Auth route:

```sh
pnpm vite
```

```sh
curl -i http://localhost:5173/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  --data '{"name":"Local User","email":"local@example.com","password":"passwordpassword"}'
```

Successful output has status `200`, a `better-auth.session_token` cookie, and the new user's email. `hubAuth()` discovers `server/auth.ts`, exposes `/api/auth/**`, and generates the Nitro route handler for production builds.

This default proves discovery and the session route locally. It is not durable storage. Configure a concrete Better Auth database adapter before relying on sessions across restarts or replicas, or use the `stateless()` preset for social sign-in without a database.

## Sessions without a database

`stateless()` keeps each session in an encrypted cookie. Sessions survive restarts and work across replicas and Workers when every instance uses the same secret.

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth";
import { stateless } from "@vite-hub/auth/presets";

export default defineAuth(({ env, requestOrigin }) => ({
  baseURL: requestOrigin,
  preset: stateless({ maxAge: "7d" }),
  socialProviders: {
    github: {
      clientId: env.auth.github.clientId,
      clientSecret: env.auth.github.clientSecret.unseal(),
    },
  },
}));
```

The preset sets `session.expiresIn`, `session.cookieCache` (`strategy: "jwe"`, `refreshCache: true`), `account.storeStateStrategy: "cookie"`, and `account.storeAccountCookie: true`. `maxAge` is seconds or a duration such as `"12h"` or `"7d"`, and defaults to 7 days. The session ends `maxAge` after sign-in. `user.id` is the first 32 hex digits of SHA-256 over the provider ID and the provider account ID, so the same provider account keeps its ID across sign-ins, instances, and restarts, and `github` account 1 differs from `discord` account 1. The preset sets it through `user.validateUserInfo` and `databaseHooks.user.create.before`, after your own hooks run. You cannot revoke one session; change `session.cookieCache.version` or rotate the secret to sign out every user.

`preset` is a ViteHub option, so Auth checks the other options against it. `database` (`AUTH_C0044`), `secondaryStorage` (`AUTH_C0045`), `emailAndPassword.enabled` (`AUTH_C0046`), plugins that store data such as `jwt()` or `magicLink()` (`AUTH_C0047`), and options that the preset sets (`AUTH_C0048`) fail when the Definition is defined or resolved.

For host routes that need runtime secrets, provider credentials, request-derived origins, or route guarding, keep that policy in the Auth Definition.

```ts
// vite.config.ts
import { hubAuth } from "@vite-hub/auth/vite";
import { env, hubEnv } from "@vite-hub/env/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubEnv(), hubAuth()],
  env: {
    server: {
      auth: {
        github: {
          clientId: env({ source: env.source("GITHUB_CLIENT_ID") }),
          clientSecret: env({ secret: true, source: env.source("GITHUB_CLIENT_SECRET") }),
        },
        secret: env({ secret: true, source: env.source("BETTER_AUTH_SECRET") }),
      },
    },
  },
});
```

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth";

export default defineAuth(({ env, requestOrigin }) => ({
  appName: "My app",
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
  access: {
    routes: ["/app", "/app/**"],
    signIn: {
      provider: "github",
      callbackURL: "/app",
      errorCallbackURL: "/app?auth_error=github",
    },
  },
  socialProviders: {
    github: {
      clientId: env.auth.github.clientId,
      clientSecret: env.auth.github.clientSecret.unseal(),
    },
  },
}));
```

When `@vite-hub/env` is installed, the Auth Definition callback receives the typed server env. It also receives `requestOrigin`, so same-origin apps do not need a separate auth URL environment variable.

Each Auth request or route guard resolves its Definition and `runtime` callbacks once. The guard uses the same resolved options for session lookup, route authorization, and automatic provider sign-in. A later request resolves fresh options.

The generated Nitro middleware uses `access.signIn` when one of the configured `access.routes` needs a browser redirect. Route objects can add an `authorize` callback when a valid session is not sufficient:

```ts
export default defineAuth({
  access: {
    routes: [
      {
        route: "/_vitehub/**",
        authorize: ({ user }) => user.isAdmin === true,
      },
      {
        route: "/api/_vitehub/console/**",
        authorize: ({ user }) => user.isAdmin === true,
      },
    ],
  },
});
```

Generated route middleware uses `createAuthAccessHandler(routes, definition?)` from `@vite-hub/auth/server`. The handler owns path and method matching, overlapping rules, and required authorization callbacks. Manual hosts can use the same handler with a Web `Request`, `{ req: Request }`, or an H3 1 event such as a Nuxt 4 server event. Its route metadata must follow the Definition's `access.routes` order; set `authorize: true` for each route that requires a callback so a missing runtime callback returns `403`. Unmatched requests do not resolve Auth.

ViteHub runs `authorize` only after authentication. Return `true` to allow the request, `false` for a `403`, or a `Response` for a custom result. The callback receives the authenticated `user`, `session`, and request; role semantics remain owned by the host. Only `true` grants access. ViteHub sends a `Response` unchanged when it is a Response of this runtime: the native `Response.prototype.status` getter accepts it. Create it with the global `Response`. Every other value gets `403`, including a Response from another Fetch implementation such as the `undici` package, a proxy, and an object shaped like a Response.

Guard your own server handlers with `withAuth(handler, definition?)` or `withAuthorization(authorize, handler, definition?)` from `@vite-hub/auth/server`. The guard returns a new handler. That handler checks the request first and calls your handler only when the check passes. Your handler receives the input and a frozen `authorization` with the checked `request`, `session`, and `user`. Otherwise the guard returns the rejection `Response`, so a missed `if` cannot run the protected action.

```ts
import { withAuth, withAuthorization } from "@vite-hub/auth/server";
import type { H3Event } from "h3";

export const me = withAuth((event: H3Event, { user }) => ({ id: user.id }));

export const photo = withAuthorization(
  ({ request, user }) => new URL(request.url).pathname.startsWith(`/photos/${user.id}/`),
  (event: H3Event) => readPhoto(event),
);
```

Annotate the input type when the host does not infer it, for example inside `defineEventHandler()`.

`withAuth()` returns JSON `401` without a session and starts the `access.signIn` redirect for HTML requests. `withAuthorization()` applies one `authorize` rule: `true` for any session or a callback. It returns JSON `401` without a session, `403` when the callback returns `false`, or the callback's `Response`. It never redirects to sign-in. Blob serve routes and Source Collections use it for their `authorize` option.

## Session refresh

Better Auth extends a stored session when the session passes `session.updateAge`. Use `session.onRefresh` to check the user again at that time, for example against a ban list.

```ts
export default defineAuth({
  session: {
    updateAge: 60 * 60,
    async onRefresh({ session, user, refresh, clear }) {
      const account = await findAccount(user.id)
      if (account.banned) return clear()
      refresh()
    },
  },
});
```

| Call | Result |
| --- | --- |
| `refresh()` | Better Auth extends the session by `session.expiresIn`. |
| `refresh(fields)` | Better Auth extends the session and writes `fields` to it, for example session `additionalFields`. The response and the cookie cache contain them. |
| Neither | The session keeps its current expiry. The next request that reaches the refresh runs the hook again. |
| `clear()` | Better Auth deletes the session, removes its cookies, and answers `401`. `withAuth()` and route guards treat it as no session. `clear()` wins over `refresh()`. |

The hook receives the `session` and `user` as stored before the refresh. To change user fields, update them in your own store: the current response still contains the user that Better Auth read before the refresh.

`onRefresh` needs a Better Auth `database` or `secondaryStorage` adapter. Without one, Auth fails with `AUTH_C0042`, because Better Auth refreshes a stateless cookie cache (`session.cookieCache.refreshCache`) without a hook. With a cookie cache in front of a database, the hook runs only when Better Auth reads the database. It does not run when `session.disableSessionRefresh` is set or for a session created without "remember me". With `session.deferSessionRefresh`, it runs on the `POST` that writes the refresh.
On H3 2, you can guard a route with middleware instead. `requireAuth(definition?)` rejects like `withAuth()`, and `requireAuthorization(authorize, definition?)` rejects like `withAuthorization()`. When the check passes, the middleware calls `next()`. The route handler reads the checked `request`, `session`, and `user` with `getAuthorization(event)`.

```ts
import { getAuthorization, requireAuth, requireAuthorization } from "@vite-hub/auth/server";
import { H3 } from "h3";

const app = new H3()
  .get("/me", event => ({ id: getAuthorization(event).user.id }), {
    middleware: [requireAuth()],
  })
  .delete("/posts/:id", event => deletePost(event), {
    middleware: [requireAuthorization(({ user }) => user.role === "admin")],
  });
```

`getAuthorization(event)` returns only what the Auth middleware attached to that event. It does not read `event.context`, so other code cannot set it. On a route without the middleware, it throws `AUTH_R0017`, so the handler fails closed. The middleware accepts any host with the same `(event, next)` contract and an event with an own `req` request.

## Vite Integration

Use `server/auth.ts` for the canonical Auth Definition, or `server.auth.ts` when a flat server file fits the project better. Vite discovers one Auth Definition, exposes it through an internal virtual module, owns `/api/auth/**` in development, and registers the same route with Nitro builds by default.

Set `route: false` only when a host integration mounts Auth itself.

```ts
export default defineAuth({
  route: false,
});
```

Manual hosts can mount the stable `#vitehub/auth/server` handler directly.

Better Auth options stay top-level. ViteHub-owned wiring reserves `access`, `database`, `secondaryStorage`, `basePath`, `preset`, `route`, `runtime`, and `session.onRefresh`. The Better Auth fields `baseURL`, `secret`, and `secrets` are runtime-only: return them from the Definition callback or place them under `runtime`. `access.routes` must be static route strings or `{ authorize, method, route }` objects so the Vite Integration can register Nitro middleware.
Better Auth options stay top-level. ViteHub-owned wiring reserves `access`, `database`, `secondaryStorage`, `basePath`, `preset`, `route`, `runtime`, and `session.onRefresh`. The Better Auth fields `baseURL`, `secret`, and `secrets` are runtime-only: return them from the Definition callback or place them under `runtime`. `access.routes` must be static route strings or `{ authorize, method, route }` objects so the Vite Integration can register Nitro middleware.


`access.routes` must use a dense array. Empty slots, including commented-out entries that leave commas, fail configuration.

```ts
export default defineAuth({
  basePath: "/auth",
  database: { name: "auth", dedicated: true },
  secondaryStorage: { store: "auth" },
});
```

`database` and `secondaryStorage` are placement metadata. ViteHub removes metadata-shaped values before calling `betterAuth()`, so they do not create Database or KV adapters. When Better Auth needs persistent storage, return its concrete `database` or `secondaryStorage` adapter from the Definition callback or `runtime`.

## Client-side Auth

Vue apps can use ViteHub's Better Auth client and normalized session composable directly. `useUserSession()` exposes the current `user` and `session`, sign-in and sign-out actions, and `loggedIn`, `pending`, and `ready` computed refs.

```ts
// lib/auth-client.ts
import { useUserSession } from "@vite-hub/auth/vue";

export const session = useUserSession();
```

That default talks to `/api/auth` on the same origin. In a Nuxt app below `app.baseURL`, such as `/app/`, it talks to `/app/api/auth`, and the server serves Auth routes and OAuth callbacks below the same path. If the Auth Definition uses a custom `basePath`, pass the same path to the Better Auth client, below the app base path.

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth";

export default defineAuth({
  appName: "My app",
  basePath: "/auth",
});
```

```ts
// lib/auth-client.ts
import { createAuthClient, useUserSession } from "@vite-hub/auth/vue";

export const authClient = createAuthClient({
  basePath: "/auth",
});
export const userSession = useUserSession(authClient);
```

The exported `createAuthClient` keeps Better Auth's option and plugin inference for custom base paths and client plugins. The zero-config composables use ViteHub's shared default client. React, Svelte, Solid, and other framework clients remain available from Better Auth's framework entrypoints.

The client loads `better-auth/vue` the first time you use it, not when you create it. An app can create its client in a plugin, and only the pages that sign in or read the session download Better Auth. Calls such as `signIn.social()` wait for the load. `useSession()` and `useUserSession()` return their refs at once: they are pending until the client loads in the browser, and stay pending during server rendering. For a member that is not a call or a hook, such as `$store`, get Better Auth's own client with `loadAuthClient()`:

```ts
import { loadAuthClient } from "@vite-hub/auth/vue";
import { authClient } from "./auth-client";

const client = await loadAuthClient(authClient);
client.$store.listen("$sessionSignal", () => {});
```

Read [Better Auth's client docs](https://www.better-auth.com/docs/getting-started/concepts/client) for framework entrypoints and session helpers.

## Authenticated Agents

Use `authenticated()` when an Agent should derive its Agent Invoker from the current Auth Session.

```ts
// server/support.agent.ts
import { defineAgent } from "@vite-hub/agent";
import { authenticated } from "@vite-hub/auth/agent";

export default defineAgent({
  invoker: authenticated(),
  driver: {
    run: ({ invoker }) => ({ invoker }),
  },
});
```

By default, the Auth Package reads the same-app Better Auth session from the request and maps the Auth User to an Agent Invoker with `kind: "authUser"`. Customize `id`, `kind`, `label`, or `meta` for normal identity shaping, and use `source` or `map` when the Agent consumes JWTs, bearer tokens, OAuth/OIDC provider output, or product-specific identity.

When authentication is required but unavailable, `authenticated()` throws `ViteHubError` with code `AUTHENTICATION_REQUIRED`. HTTP adapters map that code to `401`; the transport status is not part of the error object.

```ts
import { ViteHubError } from "@vite-hub/runtime";

const error = new ViteHubError("AUTHENTICATION_REQUIRED", "Sign in to use this Agent.");
```

`error.toJSON()` includes `name`, `code`, and `message`, while omitting `cause` and stack data. If a default Better Auth request or session operation fails, `authenticated()`, `withAuth()`, and `withAuthorization()` throw the same shared error with code `AUTH_PROVIDER_OPERATION_FAILED` and safe operation details; raw provider diagnostics remain available only through `cause`. Existing ViteHub errors and structural `AbortError` objects keep their identity. Missing APIs, malformed responses, invalid Auth configuration, and invalid custom callback results use package-owned `AUTH_C####`, `AUTH_B####`, or `AUTH_R####` Nostics codes.

## Production checks

- Supply a strong Better Auth secret from Server Env at request time; never put it in Public Env, client code, Agent input, logs, or traces. Without `secret`, `secrets`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS`, or `AUTH_SECRET`, Auth uses `deriveSecret("vitehub:auth")` from `VITEHUB_SECRET` (or `NUXT_APP_SECRET`).
- Set request-aware `baseURL` or use `requestOrigin` so callback and cookie origins match the deployed host.
- Configure a concrete Better Auth database adapter and migrations, or use `stateless()` for social sign-in without a database. ViteHub `database` and `secondaryStorage` fields are placement metadata, not adapters.
- Protect application and Console page/API routes explicitly. Authentication proves a session; application-owned `authorize` callbacks define roles and permissions.
- Keep automatic `/api/auth/**` exposure enabled unless the host mounts the stable handler itself, and verify the chosen `basePath` on both server and client.

Read the complete [Auth guide](https://vitehub.dev/docs/auth), [Auth Users and Agent Invokers](https://vitehub.dev/docs/agents/invokers), the [host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix), and the project's [pre-1.0 security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md).

## Auth event log

Opt in with `events: { store: createDatabaseAuthEventStore({ db }) }` in `defineAuth()`. The store uses the existing SQLite Drizzle `run` and `all` contract. Node SQLite and Cloudflare D1 use the same table and queries. No event database is needed when the option is absent or `false`.

The default retention is 90 days and 100,000 records, with cleanup after each append. Override `retention.maxAgeMs` or `retention.maxRecords`, or use `retention: false`. IP addresses are discarded. User agents become a coarse device class. Admin updates store field names, not secret values.

Use `listAuthEvents(filters)` and `aggregateAuthEvents({ from, to })` from `@vite-hub/auth/server`, or use the store directly. Lists use cursor pagination and one SQL query after initialization. Aggregates use one statement for a consistent snapshot and count distinct users over the whole window. `@vite-hub/auth/runtime/console` exports these readers and `readAuthEventConsoleRecords` for the Console. No Console UI is added.

For `vitehub auth events`, configure `events.authorize`. The read endpoint requires a session and an explicit `true` result. Give the CLI the Auth base URL with `--url`, and the session cookie through `VITEHUB_AUTH_COOKIE`.

Event writes are separate from auth mutations. Storage failures warn with `AUTH_EVENT_WRITE_FAILED` and do not reject a completed auth action. `impersonation.started` is the exception: without its record, the impersonation does not start. Read [Auth event log](https://vitehub.dev/docs/auth/events) for the event list, metric definitions, privacy rules, retention, and coverage limits.

## Auth Console

The primary Auth Definition adds `/_vitehub/auth` to the ViteHub Console. It lists users, active sessions, organizations, and approved OAuth clients. Better Auth additional fields become columns. Set `console.fields.<name>.editable` to allow edits, `console.columns` for batch computed values, and `console.roles` or `console.actions` for read-only policy with a reason. `console.access` holds short descriptions of the app's sign-in rules.

`getAuthConsoleForRequest(request)` from `@vite-hub/auth/server` exposes the same inspection API to trusted server code. Changes use Better Auth's plugin APIs. Impersonation is off unless the host passes `{ impersonation: true }` as the third argument, as `console.impersonation` does, and it needs `events.store`.

With Better Auth's admin plugin, Auth bounds every impersonation session. It never refreshes past `impersonationSessionDuration`, and it cannot create OAuth, MCP, or device grants, API keys, passkeys, passwords, email or phone number changes, username changes, linked accounts, two-factor settings, one-time tokens, or another impersonation. It also cannot unlink an account, or read or refresh a linked account's provider tokens (`403`, `IMPERSONATION_FORBIDDEN`). Server code reads `session.impersonatedBy`; `useUserSession()` gives `impersonatedBy` and `stopImpersonating()`. Read [Auth Console](https://vitehub.dev/docs/auth/console) for the full contract and the OAuth grant revocation limit.

Overview shows database totals and, with `events.store`, active users, a 30-day chart, sign-in methods, and recent events. Activity filters event groups and subject users before cursor pagination. User panels include recent events. Both pages show the `events.store` setup when recording is disabled. Server callers use `inspect.overview()` and `inspect.activity({ group, userId, cursor, limit })`. Manual hosts pass their event store as the third argument to `createAuthConsole(auth, consoleOptions, eventStore)`.
