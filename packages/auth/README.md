# @vite-hub/auth

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Better Auth" src="https://comark-ui.onmax.me/badge.svg?label=Better+Auth&amp;value=powered">
  <img alt="Vite" src="https://comark-ui.onmax.me/badge.svg?label=Vite&amp;value=discovery">
</p>

`@vite-hub/auth` defines one server-owned Auth Definition and turns it into a Better Auth server for ViteHub apps.

Most applications install `vite-hub`, `@vite-hub/auth`, and `better-auth`, and enable Auth through the framework preset. Use this owner package alone when a focused Vite integration, library, or manual host needs Auth without the rest of ViteHub. Better Auth still owns providers, client plugins, adapters, and sign-in UI.

## Install

```sh
pnpm add @vite-hub/auth better-auth drizzle-orm@1.0.0-rc.5 nitro
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
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubAuth(), nitro()],
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

Successful output has status `200`, a `better-auth.session_token` cookie, and the new user's email. `hubAuth()` discovers `server/auth.ts` and generates the Nitro route handler for `/api/auth/**`. Nitro serves it in development and in production builds.

This default proves discovery and the session route locally. Without `database`, a development server keeps users and sessions in the memory of its process, so a user who signs up can sign in until the process restarts. A production build without `database` or `preset` fails with `AUTH_C0063`. Use `authDatabase()` to keep users across restarts and replicas, or the `stateless()` preset for social sign-in without a database. Set `database: "memory"` only when one server process may lose its users when it restarts.

## Keep users in the app Database

```ts
// server/auth.ts
import { admin } from "better-auth/plugins";
import { defineAuth } from "@vite-hub/auth";
import { authDatabase } from "@vite-hub/auth/database";

export default defineAuth({
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  plugins: [admin()],
});
```

`authDatabase(name = "default")` is a Better Auth adapter for a `@vite-hub/database` Database. It uses the Drizzle client of each request and picks the SQLite or Postgres provider from it. The Auth Vite plugin reads the call from the Definition, so write it inline, in the object or in the object that the callback returns. The plugin then contributes the Better Auth tables to that Database through `vitehub.databases`: the core tables, the `admin()` fields, the `jwks` and `oauth*` tables that `mcpOAuth()` needs, the `organization`, `member`, and `invitation` tables and `session.activeOrganizationId` for `organization()`, the `passkey` table for `passkey()` from `@better-auth/passkey`, and the `rate_limit` table where Better Auth's limiter keeps its counters, in the dialect of the target Database (`@vite-hub/auth/schema` exports `authSqliteSchema` and `authPostgresSchema`). `vitehub database generate` writes their migration, and `vitehub inspect definitions --kind database` lists them. Without the tables, the adapter fails with `AUTH_R0019`. Tables of other plugins that only add tables go in the Database Definition.

The owned core tables have fixed columns. `authDatabase()` rejects `additionalFields` on `user`, `session`, `account`, and `verification` with `AUTH_C0055`. It also rejects plugins that add unsupported columns to owned tables, and model or field remapping, with `AUTH_C0056`. Use another Better Auth adapter with a schema that matches those options. A Database contribution cannot extend the owned tables.

## First admin

`VITEHUB_ADMINS` is a comma-separated list of social accounts, each `<provider>:<account id>`, such as `github:22072217`. When a listed account signs in or is linked, its user gets the first `adminRoles` entry of Better Auth's `admin()` plugin (`admin` by default), in place of the default role. Removing an entry does not remove the role. Without `admin()`, Auth fails with `AUTH_C0051`. The Auth Console lists the rule in its access notes. Emails are refused (`AUTH_C0058`), because a password sign-up does not prove email ownership. The removed `VITEHUB_ADMIN_EMAILS` fails with `AUTH_C0057`.

For an app without social sign-in, `vitehub auth claim` prints a one-time code and the `VITEHUB_ADMIN_CLAIM` value (its SHA-256) to set on the host. The first signed-in user who sends it to `POST <auth base>/vitehub/admin-claim` gets the admin role. A row in the `verification` table marks the code as used. A malformed value fails with `AUTH_C0059`.

Set `adminClaim: false` on another Auth Definition to make it ignore the host's claim value.

With a claim code set, Auth sets `verification.storeInDatabase: true`, including when sessions use `secondaryStorage`. Claim markers use only the database, so a secondary-storage outage cannot block reservation recovery. A failed role grant releases the reservation so the code can be tried again.

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
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubEnv({
    server: {
      auth: {
        github: {
          clientId: env({ source: env.source("GITHUB_CLIENT_ID") }),
          clientSecret: env({ secret: true, source: env.source("GITHUB_CLIENT_SECRET") }),
        },
        secret: env({ secret: true, source: env.source("BETTER_AUTH_SECRET") }),
      },
    },
  }), hubAuth(), nitro()],
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

Behind a proxy that ends TLS, set Better Auth's `advanced.trustedProxyHeaders: true`. `requestOrigin`, the default `baseURL`, and the `Origin` check then use the first `X-Forwarded-Proto` and `X-Forwarded-Host` values. Set it only when a proxy you run sets these headers. Proxy trust uses the options of the Definition, or the object that its callback returns.

Each Auth request or route guard runs its Definition callback once, then once more with the forwarded origin if the effective options trust proxy headers and that origin differs. If the second run disables trust, Auth keeps the request URL's origin and disables proxy trust. The guard uses the same resolved options for session lookup, route authorization, and automatic provider sign-in. A later request resolves fresh options. Requests with equal resolved options share one Better Auth instance. Plain values compare by value. Functions, adapters, and bindings compare by identity, so an instance never keeps an object that another request created. `authDatabase()` adapters compare by Database name. A change to a variable that the instance uses, such as `VITEHUB_SECRET`, `BETTER_AUTH_SECRET`, or `VITEHUB_ADMINS`, gives a new instance on the next request. A callback that creates plugins or other adapters on each call builds a new instance on each request, so create them outside the callback when they do not depend on the request. All guards of one request share one session lookup: access routes, `requireAuth()`, `requireAuthorization()`, `withAuth()`, `withAuthorization()`, and `withAnonymousAuthorization()`.

The generated Nitro middleware uses `access.signIn` when one of the configured `access.routes` needs a browser redirect. Route objects can add an `authorize` callback when a valid session is not sufficient:

```ts
import { defineAuth } from "@vite-hub/auth"

export default defineAuth({
  access: {
    routes: [
      {
        route: "/_vitehub/**",
        authorize: ({ user }) => user.isAdmin === true,
      },
    ],
  },
});
```

Generated route middleware uses `createAuthAccessHandler(routes, definition?)` from the private `@vite-hub/auth/internal/server` entry. The handler owns path and method matching, overlapping rules, and required authorization callbacks. Its route metadata follows the Definition's `access.routes` order; a route with `authorize: true` and no runtime callback returns `403`. Unmatched requests do not resolve Auth.

The Nitro build fails with `AUTH_B0002` when a route rule caches or prerenders a path that `access.routes` guards for `GET` or `HEAD`: `swr`, `cache`, `isr`, `prerender`, or `static`. A cached response is made for one visitor and served to others. Set `cache: false` or `prerender: false` on the guarded pattern to turn off a wider rule. In development, a route rule update that caches a guarded path logs `AUTH_B0002` as a warning.

ViteHub runs `authorize` only after authentication. Return `true` to allow the request, `false` for a `403`, or a `Response` for a custom result. The callback receives the authenticated `user`, `session`, and request; role semantics remain owned by the host. Only `true` grants access. ViteHub sends a `Response` unchanged when it is a Response of this runtime: the native `Response.prototype.status` getter accepts it. Create it with the global `Response`. Every other value gets `403`, including a Response from another Fetch implementation such as the `undici` package, a proxy, and an object shaped like a Response.

Guard your own server handlers with `withAuth(handler, definition?)` or `withAuthorization(authorize, handler, definition?)` from `@vite-hub/auth/server`. The guard returns a new handler. That handler checks the request first and calls your handler only when the check passes. Your handler receives the input and a frozen `authorization` with the checked `request`, `session`, and `user`. Otherwise the guard returns the rejection `Response`, so a missed `if` cannot run the protected action.

```ts fragment
import { withAuth, withAuthorization } from "@vite-hub/auth/server";
import type { H3Event } from "h3";

export const me = withAuth((event: H3Event, { user }) => ({ id: user.id }));

export const photo = withAuthorization(
  ({ request, user }) => new URL(request.url).pathname.startsWith(`/photos/${user.id}/`),
  (event: H3Event) => readPhoto(event),
);
```

Annotate the input type when the host does not infer it, for example inside `defineEventHandler()`.

`withAuth()` returns JSON `401` without a session and starts the `access.signIn` redirect for HTML requests. Every JSON refusal of the guards has one body in H3's error format: `{ status, statusText, message, data: { code } }`. The code is `SIGNED_OUT` for `401` and `FORBIDDEN` for `403`. Read the code, not the message. `withAuthorization()` applies one `authorize` rule: `true` for any session or a callback. It returns JSON `401` without a session, `403` when the callback returns `false`, or the callback's `Response`. It never redirects to sign-in. Blob serve routes and Source Collections use it for their `authorize` option.
`withAnonymousAuthorization(authorize, handler, definition?)` also runs the callback for a signed-out caller, with `session` and `user` set to `null`. `false` returns `401` for that caller and `403` for a signed-in one. Blob serve routes use it with `serve.anonymous: true`.

To check inside a handler, call `requireAuth(event)` or `requireAuthorization(event, authorize)`. Each returns the frozen `authorization` or throws an H3 `HTTPError`, so the rest of the handler runs only after the check passes. The errors match the guards above: `requireAuth()` throws `401` or the `access.signIn` redirect, and `requireAuthorization()` throws `401`, `403`, or an HTTP error from the callback's `Response`. The error has the same code in `data.code`, also for the text `403` of an HTML request.

The inline guards use H3's JSON error format. They keep the response status and headers, except `content-length`, which changes with the body. JSON object fields stay at the top level, and other JSON values become `data`. JSON media types, such as `application/problem+json`, stay unchanged. Text becomes `message` with a JSON content type. Use `withAuthorization()` when the response body must stay unchanged.

```ts fragment
import { requireAuth, requireAuthorization } from "@vite-hub/auth/server";
import { defineHandler } from "h3";

export const me = defineHandler(async (event) => {
  const { user } = await requireAuth(event);
  return { id: user.id };
});

export const removePost = defineHandler(async (event) => {
  await requireAuthorization(event, ({ user }) => user.role === "admin");
  return deletePost(event);
});
```

### Better Auth instance

`useAuth(event)` returns the Better Auth instance of your Auth Definition for a request event or a Web `Request`. The Vite plugin writes the type of `server/auth.ts` to `.vitehub/types/auth.d.ts`, so the instance has the endpoints of your plugins without a cast:

```ts fragment
import { requireAuthorization, useAuth } from "@vite-hub/auth/server";
import { defineHandler } from "h3";

// server/auth.ts uses `admin()` from `better-auth/plugins`.
export default defineHandler(async (event) => {
  await requireAuthorization(event, ({ user }) => user.role === "admin");
  return useAuth(event).api.listUsers({ query: { limit: 20 }, headers: event.req.headers });
});
```

## Session refresh

Better Auth extends a stored session when the session passes `session.updateAge`. Use `session.onRefresh` to check the user again at that time, for example against a ban list.

```ts fragment
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
## Vite Integration

Use `server/auth.ts` for the canonical Auth Definition, or `server.auth.ts` when a flat server file fits the project better. Vite discovers one Auth Definition, exposes it through an internal virtual module, and registers `/api/auth/**` with Nitro by default. Nitro serves the route in development too, so `/api/auth`, the Console, and server routes use one Auth instance and share its users and sessions.

Set `route: false` only when a host integration mounts Auth itself.

```ts
import { defineAuth } from "@vite-hub/auth"

export default defineAuth({
  route: false,
});
```

Manual hosts can mount the default export of `#vitehub/auth/server` directly. It is a Fetchable route, `{ fetch(request) }`. It reads the client address and the Cloudflare bindings from the Standard Context of the Request, which Nitro sets in a ViteHub app.

```ts [server/routes/api/auth/[...].ts]
export { default } from '#vitehub/auth/server'
```

For a manual adapter that creates plain Web `Request` objects, use `createAuthHandler(definition)` from `@vite-hub/auth/server` and call the returned handler as `handler(request, { clientAddress })`. Read `clientAddress` from the host's peer address, such as Node's `incomingMessage.socket.remoteAddress`, never from a client-sent header. Auth uses it for per-client rate limiting and `session.ipAddress`; without it, plain Web requests share an addressless rate-limit bucket. srvx requests already carry their host address as `ip`.

App Auth loads Better Auth on demand. Nitro imports the Auth route on its first request. The generated access middleware imports `#vitehub/auth/server` only for a request that an access route matches. Generated app Auth startup code imports `@vite-hub/auth/runtime/server`, which has no Better Auth import. Your own code loads Better Auth when it imports `@vite-hub/auth/server`, so import it in routes, not in plugins or global middleware, to keep it out of the startup.

Better Auth options stay top-level. ViteHub-owned wiring reserves `access`, `database`, `secondaryStorage`, `basePath`, `preset`, `route`, and `session.onRefresh`. The Better Auth fields `baseURL`, `secret`, and `secrets` are runtime-only: return them from the Definition callback. The callback returns all the options in one object, and Auth does not merge it with other options. `defineAuth()` rejects the removed `runtime` option with `AUTH_C0039`. `access.routes` must be static route strings or `{ authorize, method, route }` objects so the Vite Integration can register Nitro middleware.


`access.routes` must use a dense array. Empty slots, including commented-out entries that leave commas, fail configuration.

`database` and `secondaryStorage` take Better Auth adapters only. In a static Definition, `database` takes only `authDatabase()`. `authDatabase("auth")` uses the Named Database `auth`:

```ts
import { defineAuth } from "@vite-hub/auth"
import { authDatabase } from "@vite-hub/auth/database"

export default defineAuth({
  basePath: "/auth",
  database: authDatabase("auth"),
});
```

Return another Better Auth `database` adapter, or a `secondaryStorage` adapter, from the Definition callback. Auth rejects `true`, `{ name }`, and `{ store }`, because they do not create storage.

## Nuxt

Enable Auth in a Nuxt app through `vite-hub/nuxt`:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { auth: true },
})
```

`@vite-hub/auth/nuxt` is internal. `vite-hub/nuxt` loads it, and it can change in any release. Do not add it to Nuxt `modules`.

## Client-side Auth

Vue apps can use ViteHub's Better Auth client and normalized session composable directly. `useUserSession()` exposes the current `user` and `session`, sign-in and sign-out actions, `loggedIn`, `pending`, and `ready` computed refs, and the Better Auth `client`.

```ts
// lib/auth-client.ts
import { useUserSession } from "@vite-hub/auth/vue";

export const session = useUserSession();
```

`session.signOut()` calls Better Auth's `signOut()` and sets `user` and `session` to `null` at once, in every component that reads the session. It does not wait for Better Auth to read the session again. `signOut({ redirectTo: "/" })` then opens that page: a plain Vue app loads it with `location.assign()`, and Nuxt opens it with `navigateTo()`. Better Auth gets the other options, such as `fetchOptions`, and `signOut()` returns Better Auth's result. When the sign-out fails, the session and the page stay. When Better Auth sends the visitor to the provider's sign-out page, such as with OpenID Connect logout, `signOut()` opens no other page.

That default talks to `/api/auth` on the same origin. In a Nuxt app below `app.baseURL`, such as `/app/`, it talks to `/app/api/auth`, and the server serves Auth routes and OAuth callbacks below the same path.

In Nuxt, the default client also uses the Auth Definition's `basePath`. With `basePath: "/auth"` below `app.baseURL` `/app/`, `useUserSession()`, `useSession()`, and the page guard all call `/app/auth`. They share one Better Auth client. In the browser, the client uses the `app.baseURL` of the page, so a `NUXT_APP_BASE_URL` that a deployment sets at runtime also applies. On the server, Nuxt reads the session from the Nitro route, below the base path of the build.

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth";

export default defineAuth({
  appName: "My app",
  basePath: "/auth",
});
```

Outside Nuxt, pass the same path to the Better Auth client, below the app base path:

```ts
// lib/auth-client.ts
import { createAuthClient, useUserSession } from "@vite-hub/auth/vue";

export const authClient = createAuthClient({
  basePath: "/auth",
});
export const userSession = useUserSession(authClient);
```

To add Better Auth client plugins to the default client, export its options from `auth.client.ts` in the Vite root, which is `app/auth.client.ts` in a Nuxt app. `hubAuth()` finds the file. The default client loads it together with `better-auth/vue` on first use, and `useUserSession()`, `useAuthClient()`, and the Nuxt page guard share that one client. The generated `.vitehub/types/auth.d.ts` registers the type of the file, so `client.admin` is typed. Restart the dev server after you add or remove the file.

```ts
// app/auth.client.ts
import { adminClient } from "better-auth/client/plugins";
import { defineAuthClient } from "@vite-hub/auth/vue";

export default defineAuthClient({
  plugins: [adminClient()],
});
```

```ts fragment
import { useUserSession } from "@vite-hub/auth/vue";

const { client } = useUserSession();
const { data } = await client.admin.listUsers({ query: { limit: 10 } });
```

The exported `createAuthClient` keeps Better Auth's option and plugin inference for a second client with its own base path or plugins. Without `basePath`, it uses the same path as the default client. The zero-config composables use ViteHub's shared default client. Its type is `RegisteredAuthClient`: `hubAuth()` writes the type of the Auth Definition to `.vitehub/types/auth.d.ts`, so `user` and `session` have the fields that `additionalFields`, server plugins such as `admin()`, and `customSession()` add. The client imports only this type, not server code. A client from `createAuthClient()` needs Better Auth's client plugins, such as `customSessionClient<RegisteredAuth>()`, and `inferAdditionalFields<RegisteredAuth>()` for the same fields. React, Svelte, Solid, and other framework clients remain available from Better Auth's framework entrypoints.

The client loads `better-auth/vue` the first time you use it, not when you create it. An app can create its client in a plugin, and only the pages that sign in or read the session download Better Auth. Calls such as `signIn.social()` wait for the load. `useSession()` and `useUserSession()` return their refs at once: they are pending until the client loads in the browser. In Nuxt, a call in a component starts with the session that the server read for the request, so it is settled during server rendering and hydration. The browser then does not load Better Auth or read the session again until the session can change: a call such as `signOut()`, `refresh()`, the tab shows again, the network comes back, another tab signs out or updates the user, Better Auth's `refetchInterval` passes, or the session expires. Like Better Auth, it waits while the browser is offline. Better Auth then starts with the server's session, so a read that fails does not sign the page out. So without a page guard, a page that only shows the user reads the session once, on the server. When the server's session is unknown, such as on a prerendered page, the browser loads Better Auth at once. For a member that is not a call or a hook, such as `$store`, get Better Auth's own client with `loadAuthClient()`:

```ts fragment
import { loadAuthClient } from "@vite-hub/auth/vue";
import { authClient } from "./auth-client";

const client = await loadAuthClient(authClient);
client.$store.listen("$sessionSignal", () => {});
```

All calls of `useSession()` and `useUserSession()` for one client share one session state: one for each page in the browser, and one for each request on the server. A list of 100 components that call `useUserSession()` makes one Better Auth subscription, not 100. `refresh()` reads the session again, updates every component, and returns the session, or `null` without one. Calls at the same time share one read. On the server, `refresh()` returns the session that the server read for the request, and does not load Better Auth. `ready` is `true` after the first read. It stays `true` while a later read runs, and after a read that failed.

```ts fragment
import { useUserSession } from "@vite-hub/auth/vue";

const { refresh } = useUserSession();
const session = await refresh();
if (!session) console.log("Signed out");
```

Read [Better Auth's client docs](https://www.better-auth.com/docs/getting-started/concepts/client) for framework entrypoints and session helpers.

## Abilities

Write named permission rules once in `shared/abilities.ts`, next to the `server/` folder. The server and the app run the same rules. The design comes from [Capsa](https://github.com/OrlS15/nuxt-capsa) by Orlando Sica.

```ts
// shared/abilities.ts
import { defineAbilities, deny, guest } from "@vite-hub/auth/abilities";

export interface Post { authorId: string; published: boolean }

export default defineAbilities({
  "posts.read": guest((user, post: Post) => post.published || user?.id === post.authorId),
  "posts.edit": (user, post: Post) => user.id === post.authorId || "not-author",
  "posts.publish": (user, post: Post) => user.id === post.authorId || deny("not-found", { status: 404 }),
});
```

A rule gets the signed-in user, then its arguments, and returns at once. `true` allows. `false` and a code refuse with `403`, and `deny(code, { status, details })` with another 4xx status. A signed-out visitor gets `401` with the code `signed-out` before the rule runs, except in a `guest()` rule, where `user` is `null`. The Vite plugin serves the file as `#vitehub/auth/abilities` and registers its type in `.vitehub/types/auth.d.ts`, so ability names and arguments type-check.

- Server: `requireAbility(event, name, ...args)` from `@vite-hub/auth/server` returns the checked `{ request, session, user }`, or throws `AbilityError`. H3 2 sends it with the rule's status and `{ code, details }` in `data`. `can(event, name, ...args)` returns a boolean.
- Vue: `useAbility().can(name, ...args)`, `useAbility().cannot(name, ...args)`, `<Can do="posts.edit" :with="post">`, and `<Cannot>` from `@vite-hub/auth/vue`. They give no answer (`undefined`, or no content) until the session is known. `<Can>` and `<Cannot>` take the one argument of a rule in `with`, the list of any other rule in `args` (`:args="[from, to]"`), and `pending` to show nothing while data loads. The arguments go to the rule as they are, the same as on the server. `<Can>` renders the `#denied` slot with `{ code, details }` when the rule refuses. `<Cannot>` renders its default slot with `{ code, details }` only when the rule refuses. The Nuxt module auto-imports all of them.
- Vue pages: `await useAbility().authorize(name, ...args)` throws when the rule refuses, with the status and `{ code, details }` data of `requireAbility()`. In Nuxt, the error is fatal and shows the error page. Without Nuxt, it is an `AbilityError`. In the browser, except while Nuxt hydrates, it sends one `/get-session` request for the current session. On the server, a session that the server could not read counts as signed out.

Nuxt uses the Auth Definition's base path for the shared browser client. In other Vue apps, call `provideAuthClient(client)` from `@vite-hub/auth/vue` in a parent component's setup to share a custom client with descendant Auth composables and `<Can>`. You can also pass a client directly to `useAbility(client)`.

`requireAuthorization(event, authorize)` checks inside the handler, and `withAuthorization()` wraps it. Use them for checks that need only the user. A rule that needs data the handler loads belongs in `shared/abilities.ts`.

## Nuxt: server session and page guard

In Nuxt, the server reads the session only for a page that needs it: a page with an `auth` guard, or a page whose components call `useUserSession()`, `useSession()`, or `useAbility()`, or render `<Can>`. It reads the session once for each page request, waits for it before it renders those components, settles their refs as soon as it has the session, so an async `setup()` can wait for `ready`, and sends it to the browser in the page payload, without the session token. `useUserSession()` and `useSession()` start from it, so a signed-in page renders signed in on the server and does not flash signed out while Better Auth loads. A call outside a component, such as in a plugin or a route middleware, cannot make the server wait, so on the server it starts pending unless the page guard already read the session. To protect a page, use the `auth` page guard. A request without a session cookie skips the lookup, so pages for signed-out visitors do not load Better Auth. A prerendered or cached page was rendered without the visitor's cookie, so its session counts as unknown.

The browser downloads Better Auth's client only when the page uses it. Nuxt does not prefetch it on other pages.

The server session lookup, the page guard, and the auto-imported composables use the Auth Definition's `basePath`, below Nuxt's `app.baseURL`.

During server rendering, a client call such as `listSessions()` or a plugin endpoint such as `organization.list()` calls the app in-process with the visitor's cookie. Call it in `<script setup>` or in `useAsyncData()`, and the page renders its data on the server. When Better Auth refreshes the session cookie, the page response sets it. A client with its own `baseURL` or `fetchOptions.customFetchImpl` keeps them, so its server calls do not carry the visitor's cookie. Better Auth's origin check refuses a `POST` call during server rendering with `403`, so make calls that change data in the browser. A prerendered or cached page renders without the visitor's cookie, so its calls answer as signed out.

```vue
<!-- app/pages/sessions.vue -->
<script setup lang="ts">
import { useAuthClient } from "vite-hub/auth/vue";

const { data: sessions } = await useAsyncData("sessions", async () => {
  const { data } = await useAuthClient().listSessions();
  return data ?? [];
});
</script>
```

`definePageMeta({ auth })` guards a page on the server and on client navigation:

| `auth` | Who may open the page | Others go to |
| --- | --- | --- |
| `'user'` or `true` | Visitors with a session | `redirects.login` (default `/login`), with `?redirect=<the page>` |
| `'guest'` | Visitors without a session, such as on the login page | `redirects.guest` (default `/`) |
| `{ only, redirectTo }` | `only` is `'user'` or `'guest'` | `redirectTo` |
| `false` or unset | Everyone | |

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { auth: { redirects: { login: "/sign-in", guest: "/app" } } },
})
```

On client navigation, the guard reads the session into the same state as `useUserSession()` and `useSession()`. When the guard finds that the session ended, such as after a sign-out in another tab, every component shows the visitor as signed out before the redirect.

The guard runs when the route changes. A sign-out does not change the route, so `signOut()` of `useUserSession()` does the guard's work: on a `'user'` page, it sends the visitor to the login page of that page, with `?redirect=<the page>`. `redirectTo` takes priority. Other pages stay open.

The page guard decides where the browser goes. Protect data in server routes with `withAuth()`, `requireAuth()`, or `access.routes`. Read [Protect pages in Nuxt](https://vitehub.dev/docs/auth/protect-pages) for the full task.

## GitHub organization membership

`isGitHubOrgMember(accessToken, org, { cacheMs, timeoutMs })` from `@vite-hub/auth` returns `true` only for an active membership. The token needs `read:org`. A pending invitation, a non-2xx response, a network error, or a timeout (default 5 seconds) returns `false`. There is no cache by default. With `cacheMs`, a successful check is kept in memory for that time per token and organization, under a SHA-256 key.

```ts fragment
import { isGitHubOrgMember } from "@vite-hub/auth";

const member = await isGitHubOrgMember(account.accessToken, "acme", { cacheMs: 300_000 });
```

## MCP OAuth

`@vite-hub/auth/mcp` makes Better Auth the OAuth 2.1 authorization server of an MCP server that the app owns, such as `/mcp`. `mcpOAuth({ resource, loginPage })` returns `jwt()`, `oauthProvider()` with open dynamic registration for native MCP clients, and a guard that bounds the registration body and its fields. `serveMcpOAuthDiscovery(request)` answers the protected resource, authorization server, and OpenID documents at the origin root and returns `undefined` for other paths. `verifyMcpRequest(request)` returns `[error, caller]` with the user, scopes, and client name of a valid access token. `deleteUnusedMcpClients()` deletes registrations that never finished sign-in. Install `@better-auth/oauth-provider` with the version of `better-auth` that this package uses.

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth"
import { mcpOAuth } from "@vite-hub/auth/mcp"

export default defineAuth(({ requestOrigin }) => ({
  baseURL: requestOrigin,
  plugins: [...mcpOAuth({ resource: `${requestOrigin}/mcp`, loginPage: "/oauth" })],
}))
```

Read [Sign MCP clients in](https://vitehub.dev/docs/auth/configure#sign-mcp-clients-in).

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

- Supply a strong Better Auth secret from Server Env at request time; never put it in Public Env, client code, Agent input, logs, or traces. Without `secret`, `secrets`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS`, or `AUTH_SECRET`, Auth uses `deriveSecret("vitehub:auth")` from `VITEHUB_SECRET`.
- Set request-aware `baseURL` or use `requestOrigin` so callback and cookie origins match the deployed host.
- Use `authDatabase()` and apply its migration, configure another Better Auth database adapter, or use `stateless()` for social sign-in without a database.
- Protect application routes and the Console endpoint explicitly. Authentication proves a session; application-owned `authorize` callbacks define roles and permissions.
- Keep automatic `/api/auth/**` exposure enabled unless the host mounts the stable handler itself, and verify the chosen `basePath` on both server and client.

## Passwords in a WebContainer

In a StackBlitz WebContainer, every `node:crypto` `scrypt` call fails. There, Auth sets `emailAndPassword.password` to the scrypt of `@noble/hashes`, with Better Auth's default parameters and `salt:key` format. A hash made on another host verifies in the WebContainer, and the other way around. Auth logs one `[vitehub] Auth hashes passwords with the scrypt of @noble/hashes` line when it first builds its options. Hashing is slower (about 3 seconds per sign-up or sign-in). A `hash` or `verify` function in the Auth Definition always wins. Other hosts keep Better Auth's default.

Read the complete [Auth guide](https://vitehub.dev/docs/auth), [Auth Users and Agent Invokers](https://vitehub.dev/docs/agents/invokers), the [host support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix), and the project's [pre-1.0 security policy](https://github.com/vite-hub/vitehub/blob/main/SECURITY.md).

## Auth event log

Opt in with `events: { store: createDatabaseAuthEventStore({ db }) }` in `defineAuth()`. The store uses the existing SQLite Drizzle `run` and `all` contract. Node SQLite and Cloudflare D1 use the same table and queries. No event database is needed when the option is absent or `false`.

The default retention is 90 days and 100,000 records, with cleanup after each append. Override `retention.maxAgeMs` or `retention.maxRecords`, or use `retention: false`. IP addresses are discarded. User agents become a coarse device class. Admin updates store field names, not secret values.

Use `listAuthEvents(filters)` and `aggregateAuthEvents({ from, to })` from `@vite-hub/auth/server`, or use the store directly. Lists use cursor pagination and one SQL query after initialization. Aggregates use one statement for a consistent snapshot and count distinct users over the whole window. `@vite-hub/auth/runtime/console` exports these readers for the Console. No Console UI is added.

For `vitehub auth events`, configure `events.authorize`. The read endpoint requires a session and an explicit `true` result. Give the CLI the Auth base URL with `--url`, and the session cookie through `VITEHUB_AUTH_COOKIE`.

Event writes are separate from auth mutations. Storage failures warn with `AUTH_EVENT_WRITE_FAILED` and do not reject a completed auth action. `impersonation.started` is the exception: without its record, the impersonation does not start. Read [Auth event log](https://vitehub.dev/docs/auth/events) for the event list, metric definitions, privacy rules, retention, and coverage limits.

## Auth Console

The primary Auth Definition adds an Auth section to the ViteHub Console. It lists users, active sessions, organizations, and approved OAuth clients. Better Auth additional fields become columns. Set `console.fields.<name>.editable` to allow edits, `console.columns` for batch computed values, and `console.roles` or `console.actions` for read-only policy with a reason. `console.roles.read` gives the Console roles that the app computes, for labels and the Admins filter, without writing them. `console.access` holds short descriptions of the app's sign-in rules.

`getAuthConsoleForRequest(request)` from `@vite-hub/auth/server` exposes the same inspection API to trusted server code. Changes use Better Auth's plugin APIs. Impersonation is off unless the host passes `{ impersonation: true }` as the third argument, as `console.impersonation` does, and it needs `events.store`.

With Better Auth's admin plugin, Auth bounds every impersonation session. It never refreshes past `impersonationSessionDuration`, and it cannot create OAuth, MCP, or device grants, API keys, passkeys, passwords, email or phone number changes, username changes, linked accounts, two-factor settings, one-time tokens, or another impersonation. It also cannot unlink an account, or read or refresh a linked account's provider tokens (`403`, `IMPERSONATION_FORBIDDEN`). Server code reads `session.impersonatedBy`; `useUserSession()` gives `impersonatedBy` and `stopImpersonating()`. Read [Auth Console](https://vitehub.dev/docs/auth/console) for the full contract and the OAuth grant revocation limit.

Overview shows database totals and, with `events.store`, active users, a 30-day chart, sign-in methods, and recent events. Activity filters event groups and subject users before cursor pagination. User panels include recent events. Both pages show the `events.store` setup when recording is disabled. Server callers use `inspect.overview()` and `inspect.activity({ group, userId, cursor, limit })`. Manual hosts pass their event store as the third argument to `createAuthConsole(auth, consoleOptions, eventStore)`.
