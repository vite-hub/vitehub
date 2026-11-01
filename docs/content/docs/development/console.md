---
title: Console
description: Enable the Console, inspect configured primitives, and protect its routes.
navigation.order: 32
navigation.group: Local tools
icon: i-lucide-monitor-dot
---

The ViteHub Console inspects the primitives enabled in the same ViteHub configuration. It is off by default. Enable it, start the app, then open `/_vitehub` to choose a section.

ViteHub renders the Console UI and serves its static assets. Agents reach the same operations through the [MCP endpoint](/docs/development/mcp) at `/_vitehub/mcp`.

The Console sends each call as one same-origin `POST` to `/_vitehub/rpc/__call` with `{ operation, input }`. An [operation](/docs/development/operations) is a named ability such as `invocations.list` or `content.publish`. The CLI calls the same route, so the same interface works on development servers and production hosts without separate resource routes.

The Console sections are Auth, Env, Connections, Agents, Channels, Usage, Logs, Content, Comments, Blob, Databases, Email, KV, Rate Limits, Sandbox Tasks, Workspaces, Workflows, Queues, and Schedules. The home shows only configured primitives in a grid and places the last opened primitive first, with that preference stored in the browser. Opening a section replaces the sidebar items with that section's navigation, and **All sections** returns to the Console home. **Search console**, <kbd>⌘</kbd> <kbd>K</kbd>, or <kbd>/</kbd> opens a command palette with the sections and their pages, Content documents, Agents, and retained sessions when Agents is enabled. Channels lists the Channels of the Agents, their conversation threads, and each conversation with its attachments and the runs that answered, with downloads as Markdown or JSON and a warning when the transcripts are not durable. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation). Content appears when `server/content.ts` defines document collections and edits them: it saves drafts, publishes, and restores revisions, and `content.can()` decides what each user may do. See [Edit Content in the Console](/docs/content/console). Comments appears when `server/comments.ts` exists. It lists the threads that the team left on the app's pages, and opening the Console turns on the [ViteHub tools pill](#open-the-console-from-the-apps-pages), with the Comments toolbar, on those pages for you. See [Comment as the Console team](/docs/comments/configure#comment-as-the-console-team). Blob lists configured stores and bounded pages of object metadata without downloading contents or exposing provider URLs, and uploads (up to 8 MiB) or deletes objects through the `blob.put` and `blob.del` operations. Database lists discovered Definitions, their source metadata, definition mode, and statically discovered table names without connecting to a database. When the schema is imported or spread, the Tables field says so instead of listing tables it cannot see. KV lists configured stores and keys, then fetches a value only after the key is selected, and edits or deletes it through the `kv.set` and `kv.del` operations. Rate Limit lists statically discovered policies and source locations, and reads or resets the live counter of a key you enter through the `rate-limit.peek` and `rate-limit.reset` operations. Sandbox lists discovered Definitions without starting runtime resources. Workspace lists discovered Definitions and source roots without initializing workspace stores, Sources, files, or processes. Workflow and Queue list discovered Definitions and their source metadata without loading the Definition modules. Schedule shows one table of discovered Schedule Definitions, with their cron expression, time zone, and manual state. It runs a Definition that sets `manual: true`, and `vitehub schedule runs <name>` lists its recorded runs.

Console data can contain user prompts, model output, tool activity, Blob metadata, provider metadata, and stored KV values. Protect the Console before making it reachable on a production URL.

### Section pages and URLs

A section can have pages next to its main view. Content has a dashboard, a Settings page when it defines a singleton, and, when Blob is enabled, a Media page. Each page has its own URL, so links, reloads, and Back work:

| URL | Opens |
| --- | --- |
| `/_vitehub/content` | The section's index page, the Content dashboard. A section without one opens its main view. |
| `/_vitehub/content/-/media` | Another page of the section. |
| `/_vitehub/content/-/settings` | The singletons of the section, such as site settings. |
| `/_vitehub/content/posts` | The `posts` collection in the main view. |
| `/_vitehub/content/settings` | The editor of the `settings` singleton. |
| `/_vitehub/content/posts/2026/launch` | The document `2026/launch` of `posts`. |

The `-` segment separates pages from the main view, so a collection named `media` stays a collection. `/_vitehub/content/-/dashboard` redirects to `/_vitehub/content`. The Vite Console and the Nuxt module register the same routes.

Pages share the access of their section. `{ sections: ['content'] }` in `console.authorize` allows the dashboard, Settings, Media, and every collection. There is no separate page scope; the owner policy, such as `content.can()`, still decides what each action may do.

The section sidebar collapses to icons with the button in its header. The Console stores the collapsed state and the sidebar width in the browser.

### Search

<kbd>⌘</kbd> <kbd>K</kbd> or <kbd>/</kbd> opens search from any Console page.

| Group | Items |
| --- | --- |
| Content | Draft documents of every collection you may read, matched by title, id, fields, and body. With an empty query, the recently changed documents. |
| Actions | Commands of the current page, **New** for each collection you may edit, **Publish all changes** when you may publish, and the theme commands. |
| Go to | The Overview, each section, its pages, and its collections. |

Items also match aliases, such as `images` for Media and `deploy` for **Publish all changes**. <kbd>Enter</kbd> opens the highlighted item and <kbd>⌘</kbd> <kbd>Enter</kbd> opens it in a new tab. **Publish all changes** opens a list of the changes it will publish; choose **Publish N changes** to publish exactly those drafts, or press <kbd>Backspace</kbd> on an empty query to go back.

### Update ready

Each build of the Console has an id. The id changes only when the Console catalog or the Console client changes, so a deploy that changes neither keeps it. An open Console compares its id with the deployed one when the tab becomes visible and once a minute. When they differ, **Update ready** shows at the bottom of the rail. Choose it to reload the Console. The sections response returns the deployed id as `build`.

## Enable the Console

Set `console` in the root ViteHub integration. Every environment must choose who can open the Console with `console.auth`:

| `auth` | Who can open the Console |
| --- | --- |
| `false` | Anyone who can reach `/_vitehub`. Use it on your own machine, or behind a host that already checks every request. |
| `'app'` | Users with a session from the app [Auth](/docs/auth). |
| `{ ... }` | Users of a separate Console Auth: inline GitHub sign-in, a Console Auth server file, or Cloudflare Access. |

For local development, use `auth: false`:

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    agent: true,
    blob: true,
    console: { auth: false },
    preset: 'cloudflare',
    kv: true,
    schedule: true,
    workflow: true,
  })],
})
```

A standalone Nitro 3 app adds Nitro after ViteHub. The Console app and its UI dependencies ship inside `vite-hub`, so an existing Nitro app does not need another Console or UI package.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vitehub({
      agent: true,
      console: { auth: false },
      preset: 'node',
    }),
  ],
})
```

Nuxt uses the same option. The Console is its own page with its own styles, so it does not need Nuxt UI or Tailwind in your app, and your app's theme, fonts, and layouts do not change how it looks.

```ts [nuxt.config.ts]
import viteHubNuxt from 'vite-hub/nuxt'

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, {
      agent: true,
      console: { auth: false },
      preset: 'node',
    }],
  ],
})
```

Restart the development server after changing the option. Open `http://localhost:3000/_vitehub`, using your app's actual origin and port.

### Open the Console in DevTools

On a development server, the Console is also a **ViteHub Console** entry in the DevTools of your app:

| App | Where |
| --- | --- |
| Nuxt | A tab in Nuxt DevTools 3 and 4. |
| Vite with [`@vitejs/devtools`](https://devtools.vite.dev) | An entry in the Vite DevTools dock, which Devframe renders. |

The entry shows the same `/_vitehub` page in a frame. In development, the page lets frames of the same origin show it. A production build still refuses every frame.

With independent Console Auth, the sign-in button opens authentication in the main browser page. Open DevTools again after signing in.

`console: true` reuses the app Auth Definition and its server access policy. Enable `auth: true` and authorize the Console routes in `server/auth.ts`, as shown below. A `console` object still requires an explicit `auth` choice.

App Auth and the Console must use the same public origin, including the protocol and port. The Console rejects a different resolved Auth `baseURL` before starting sign-in or initializing its account client. Serve Auth on the Console origin or configure independent Console Auth when the app's Auth runs on another origin.

`auth: false` also works in a production build. The build and the production server log a warning, because anyone who can reach the route can read Console data. Before you deploy, add `authorize` or choose another `auth`. See [Protect the Console route](#protect-the-console-route).

If `console` is omitted or set to `false`, ViteHub does not register a Console page, RPC route, Nitro plugin, or public asset path. A disabled Console returns the host's normal not-found response.

## Inspect environment declarations

Open Env to search declared Server Env variables and filter by source. Select a variable to inspect its provider, secret flag, requirement, and whether a default is configured. Host environment includes process environment variables and host runtime bindings.

This view does not read secret values, call external providers, or check credential validity. It does not enumerate undeclared host variables. Values and defaults remain hidden. Update host values through the deployment configuration and provider values in their connected store. Set `env: false` in ViteHub options to disable Env and its Console section.

## Manage Connections

Open Connections to see each [Connection](/docs/connections) from `server/connections/`. Each row shows the status, the type (**OAuth** or **API key**), and the account. A row that needs an action shows one button: **Connect** or **Set key** when it is not connected, and **Reconnect** or **Replace key** when it stopped working or misses declared scopes. Missing scopes and pending approvals show only when there are some. The Console does not create Connections: add a Connection Definition to `server/connections/`, then connect it here.

**Connect** opens the provider consent page in the same tab. The result page shows the outcome and returns to Connections. A failure shows its error code, the fix, and a link back. Select a row to open its details:

- **Connection** shows the account, scopes, and last error. **Connect** or **Reconnect** starts the provider consent flow and returns to the Console. For an API key Connection, **Set key** or **Replace key** stores a new key. The Console sends it only over HTTPS or to a loopback host. **Refresh token** refreshes the access token. **Disconnect** deletes the grant. It also revokes the grant at the provider when the provider supports revocation.
- **Access** shows the rules from the Connection Definition for server code, routes, and Agents.
- **Activity** lists Agent calls, writes, denials, failures, and account changes, newest first. Agent calls link to their Invocation. Activity has no request or response bodies or headers.

The Console registers `POST /_vitehub/connections`, `GET /_vitehub/connections/connect/:name`, and `GET /_vitehub/connections/callback` only when Connections is enabled. Each route runs the Console access policy itself, in development and in production, the same as the Console data routes. With Console Auth or app Auth, actions record the signed-in user as `user:<id>`. With `auth: false`, actions record `user:open`. With Cloudflare Access, they record `user:cloudflare-access`. When `console.authorize` returns `{ sections }`, the routes also need the `connections` section. The Connections section is not available in Nuxt apps.

Starting Connect creates a single-use OAuth `state` in the Connections store. The browser opens the GET connect route, receives a `state` cookie and a cookie with the Console page to return to, and follows a redirect to the provider. The provider redirects back to the GET callback route. The callback consumes the stored `state` and checks the browser cookie and the manager before it saves the grant. A `state` from another manager returns `403`. Proxies must forward both GET routes, their query strings, and cookies, as well as the management POST route. When Vite `base` is set, these routes use that mount prefix.

## Develop against a fixture

Use `vitehub console dev` when Console work needs the same Agent Invocations on every restart. The command validates a versioned JSON fixture, then starts the development command after `--` with an in-memory Console journal. It does not write `.vitehub/data/console.sqlite`.

```bash [Terminal]
pnpm vitehub console dev \
  --fixture test/fixtures/console.fixture.json \
  -- pnpm dev
```

Fixture paths resolve from the Vite project root. Put records in oldest-to-newest order so the generated journal cursors produce the expected newest-first session list. A version 1 fixture contains complete `AgentInvocationRecord` values. `cursor` is optional because fixture mode assigns one from the array order.

```json [test/fixtures/console.fixture.json]
{
  "version": 1,
  "invocations": [
    {
      "id": "fixture_support_reply",
      "traceId": "fixture_trace_support",
      "agentName": "support",
      "status": "completed",
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:02.000Z",
      "completedAt": "2026-08-27T10:00:02.000Z",
      "observations": [
        {
          "name": "agent.message",
          "type": "run",
          "sequence": 1,
          "timestamp": "2026-08-27T10:00:01.000Z",
          "attributes": {
            "message.role": "assistant",
            "message.content": "Your fixture is ready."
          }
        }
      ]
    }
  ]
}
```

The wrapper preserves the child command's exit status, translating signal termination to the conventional `128 + signal number` status. Invalid arguments, unreadable files, malformed JSON, unsupported fixture versions, duplicate invocation ids, and invalid records print a diagnostic to stderr and return status `1` without starting the development command. Fixture mode is development-only, and a production build rejects the fixture environment before it generates server output.

Fixtures often contain prompts and model output. Use synthetic or scrubbed records before committing them.

## Protect the Console route

The Console registers its page and assets under `/_vitehub/**`, and its RPC route under `/_vitehub/rpc/**`. Provider status also uses `GET /api/_vitehub/console/status`. It also serves the [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-your-app) as static files under `/_vitehub/.well-known/skills/`, so `npx skills add <app>/_vitehub` installs the skill version of the installed `vite-hub` package. These files need no Console sign-in.

ViteHub sends `X-Robots-Tag: noindex, nofollow` on the Console route and includes the equivalent robots meta tag in the standalone Console page. These directives keep the Console out of search engines that honor them. They do not restrict access, so choose an access policy below.

### Use the app Auth

Enable the Console with the app's existing server Auth Definition and access policy:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    auth: true,
    console: true,
    preset: 'node',
  })],
})
```

Keep the providers, database, and session configuration in `server/auth.ts`. Add access routes that decide who can use the Console:

```ts [server/auth.ts]
import { defineAuth, type AuthAccessAuthorize } from 'vite-hub/auth'

const authorizeConsole: AuthAccessAuthorize = ({ user }) =>
  user.role === 'admin'

export default defineAuth({
  // Keep the app's existing providers, database, and session options here.
  access: {
    routes: [
      { route: '/_vitehub/**', authorize: authorizeConsole },
      { route: '/api/_vitehub/console/**', authorize: authorizeConsole },
    ],
  },
})
```

The `role` field is an application example. Use the app's existing role, permission, or allowlist. A missing session returns `401`. After sign-in, the callback receives the request and signed-in `user`. Returning `false` returns `403` and offers **Switch account**. A custom `Response` controls the rejection or redirect.

App Auth provides a built-in page at `/_vitehub/sign-in`. It shows an email and password form when `emailAndPassword` is on, and lists the configured social providers. It signs in through the existing Auth endpoints and returns to the requested Console page. Failed attempts show the form and the provider buttons again. Expired sessions show a clickable **Sign in** action. The account menu uses the same app session and supports sign-out. No Console Auth Definition, client, or sign-in route is needed.

ViteHub requires an authorization callback for every Console route, including `GET /api/_vitehub/console/status` and, when enabled, `GET /api/_vitehub/console/usage`. The two wildcard routes above cover them. Missing policy stops the build with `VITE_HUB_B0006`. Missing app Auth stops it with `VITE_HUB_B0005`. `console: true` never grants access to every signed-in user by itself.

For section-specific permissions or a separate Console policy, use an authorization file:

```ts [vite.config.ts]
console: { auth: 'app', authorize: './server/console-authorize.ts' }
```

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => user?.role === 'admin')
```

For two-factor authentication, passkeys, or a custom sign-in UI, override the page. The built-in page does not complete two-factor challenges:

```ts [vite.config.ts]
console: { auth: 'app', signInPage: '/sign-in' }
```

The custom page receives `redirect`, such as `/sign-in?redirect=%2F_vitehub%2Fauth`. Return there after sign-in, accepting only paths on your origin. ViteHub adds the application's mount base. `auth: false` with an `authorize` that returns `401` uses `signInPage` in the same way. Independent Console Auth has its own page and does not take this override.

### Use Console Auth

Console Auth has its own Better Auth session. It does not require the application's Primary Auth Definition. For a Node host, the inline GitHub setup accepts only verified email addresses in `allowedEmails`:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: {
      auth: {
        provider: 'github',
        allowedEmails: ['maintainer@example.com'],
        databasePath: '/var/lib/app/console-auth.sqlite',
        baseURL: 'https://agent.example.com',
      },
    },
    preset: 'node',
  })],
})
```

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and [`VITEHUB_SECRET`](/docs/env/app-secret) in the server environment. Console Auth signs sessions with a secret derived from `VITEHUB_SECRET`; `BETTER_AUTH_SECRET` wins when it is set, and `secretEnv` names another required variable. Rotating either secret signs out every Console session. `baseURL` is the public origin used for OAuth redirects; set it when a proxy terminates TLS. The GitHub callback URL is `https://agent.example.com/api/_vitehub/console/auth/callback/github`. For Nuxt apps mounted below `/`, ViteHub includes `app.baseURL` in the callback and redirects. Put `databasePath` on persistent storage. Console Auth creates or updates its Better Auth tables before the first protected request. It refuses a missing database or secret. Application requests and channel requests keep their own authentication.

If you previously protected the Console through Primary Auth, remove its `/_vitehub/**` and `/api/_vitehub/console/**` access routes when you switch to Console Auth. Keep `auth: true` if application routes still use Primary Auth. Otherwise, both auth guards apply and maintainers must sign in twice.

Inline Console Auth uses `node:sqlite` and requires the Node deployment preset. Other presets need a file-based Console Auth Definition with a database adapter supported by the host.

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `BETTER_AUTH_SECRET` in the server environment. `baseURL` is the public origin used for OAuth redirects; set it when a proxy terminates TLS. The GitHub callback URL is `https://agent.example.com/api/_vitehub/console/auth/callback/github`. For Nuxt apps mounted below `/`, ViteHub includes `app.baseURL` in the callback and redirects. Put `databasePath` on persistent storage. Console Auth creates or updates its Better Auth tables before the first protected request. It refuses a missing database or secret. Application requests and channel requests keep their own authentication.

For a custom provider, GitHub organization check, or Better Auth server plugins, commit `vitehub/console/auth/server.ts` and use `console: { auth: {} }`. The file can import `defineAuth` and export a Console definition:

```ts [vitehub/console/auth/server.ts]
import { DatabaseSync } from 'node:sqlite'
import { defineAuth } from 'vite-hub/auth'
import { defineConsoleAuth } from 'vite-hub/console/auth'

const database = new DatabaseSync('/var/lib/app/console-auth.sqlite')

export default defineConsoleAuth({
  auth: defineAuth(() => ({
    baseURL: process.env.CONSOLE_AUTH_BASE_URL,
    database,
    secret: process.env.BETTER_AUTH_SECRET,
    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    },
  })),
  signIn: { provider: 'github' },
  authorize: ({ user }) => user.email === 'maintainer@example.com',
})
```

ViteHub fixes this definition's auth route to `/api/_vitehub/console/auth/**` and its cookie prefix to `vitehub_console`. It guards `/_vitehub/**` and every method under `/api/_vitehub/console/**`, including the RPC route and invocation actions. An unauthenticated browser visit opens `/_vitehub/sign-in`; the provider redirect starts only after the user selects its sign-in button. Console APIs return 401 without a session. The sign-in page and auth callback are excluded from the guard. The server file must provide a Better Auth database adapter and a secret. The host must place that database on durable storage. ViteHub runs Better Auth migrations before serving the first protected request. Set `migrate: false` only when your own startup process has applied the schema.

An optional `vitehub/console/auth/client.ts` can provide Better Auth client plugins and a `setup` hook. ViteHub bundles it for the Console pages only. `setup` receives the client from `createAuthClient()`; use `loadAuthClient(client)` from `vite-hub/auth/vue` for members that are not calls, such as `$store`:

```ts [vitehub/console/auth/client.ts]
import { defineConsoleAuthClient } from 'vite-hub/console/auth/client'

export default defineConsoleAuthClient({
  plugins: [],
  setup(client) {
    // Add Console-only browser behavior here.
  },
})
```

Use `console.auth.server` or `console.auth.client` for a file in another location. An explicit path conflicts with the corresponding discovered file. Client code does not authorize requests.

On Cloudflare, use `console: { auth: { provider: 'cloudflare-access' } }` with a Cloudflare Access application. See [Cloudflare](/docs/frameworks-hosts/cloudflare).

### Use another authentication library

Apps that use another authentication library set `auth: false` and give the Console an `authorize` function:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: { auth: false, authorize: './server/console-authorize.ts' },
    preset: 'node',
  })],
})
```

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'
import { readHostSession } from './session'

export default defineConsoleAuthorize(async ({ request }) => {
  const session = await readHostSession(request)
  if (!session) return new Response('Sign in first.', { status: 401 })
  return session.user.role === 'admin'
})
```

`readHostSession()` is an example of your own session code. With `auth: false`, `authorize` receives only the Web `Request`. Keep your host middleware as a first layer if you already have one.

### Limit a user to some sections

`authorize` works with every `auth` choice. Every Console data route calls it with the Web `Request` before it reads data. This includes the RPC route, invocation actions, Env management, Channel replay, Schedule runs, and Connections management. The page shell, the client script, and static assets do not call it, because they contain no project data. With `signInPage`, a visit to a Console page also runs the access check, to send a user without a session to sign in.

`authorize` returns one of these values:

| Result | Effect |
| --- | --- |
| `true` | Allows every Console section. |
| `{ sections: ['content'] }` | Allows only these section ids, with every action of the section. An empty list returns `403`. |
| `{ sections: ['kv:read'] }` | Allows the section `kv` for reads only. Operations of kind `write` or `destructive` return `403`, unless the call only reads (`readOnlyWhen`). |
| `false` | Returns `403`. |
| A `Response` | Returns that response, for example a `401` or a redirect. |

Any other value returns `500`. With `auth: 'app'` and with session-based Console Auth, the context also has the signed-in `user`:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => {
  if (user?.role === 'admin') return true
  if (user?.role === 'editor') return { sections: ['content'] }
  return false
})
```

A section entry is the section id, or `'<section>:read'` for a read-only role. A read-only grant allows only `kind: 'read'` operations of the section, and the calls that `readOnlyWhen` marks as read only, on every surface: the Console RPC, `vitehub <namespace> --url`, agent tools, and MCP. Write routes such as Env management, Schedule runs, Channel replay, Agent Invocations, and media upload refuse it. List `'kv:read'` and `'kv'` together and the full grant wins. The Console hides the write actions of a section it may only read, such as the KV editor and the Blob upload.

::warning
Breaking change: a section grant now includes the write actions of its section. `{ sections: ['kv'] }` lets a user set and delete keys, `'blob'` lets them upload and delete blobs, and `'rate-limits'` lets them reset counters, where these pages only read before. Use `'<section>:read'`, for example `{ sections: ['kv:read', 'blob:read'] }`, for a read-only role.
::

Section ids are the ids in the Console URL, such as `env`, `connections`, `agents`, `usage`, `content`, `blob`, `databases`, `kv`, `workspaces`, `workflows`, `queues`, and `schedules`. Each Console route and RPC operation declares its section, and the server returns `403` for a section outside the list. Write actions follow the section that owns them: Env management needs `env`, Connections management needs `connections`, Agent Invocations and Channel replay need `agents`, Schedule runs need `schedules`, Workflow starts, cancels, and resumes need `workflows`, and Content saves and publishes need `content`. Content then checks `content.can()` for the signed-in user, so `{ sections: ['content'] }` gives an editor the section, and `defineContent({ authorize })` decides which collections and actions they get. The Console navigation shows only the allowed sections. That is a convenience. The server check is the security boundary.

### How each mode checks a request

Each Console data route checks access itself. The Console Auth middleware stays as a first layer in front of the routes.

| Configuration | Check in each Console data route |
| --- | --- |
| `auth: false` | Allows the request. A production build and a production server log a warning. |
| `auth: 'app'` | Checks the Primary Auth Session and every Auth access route that protects the Console. Returns `401` or `403`. |
| `auth: { ... }` | Checks the Console Auth Session and its `authorize` callback with `withAuthorization()`. Returns `401` or `403`. It does not redirect to sign-in. |
| `auth: { provider: 'cloudflare-access' }` | Verifies the Cloudflare Access token. Development has no Access edge, so the development server allows the request. |
| `authorize` | Runs after any of the checks above. It can reject the request or limit it to some sections. |

All Console paths in this guide use the application base: an explicit ViteHub application base (set from Nuxt `app.baseURL`), otherwise a root-relative Vite `base`. With `base: '/portal/'`, host middleware that you keep as a first layer must authenticate and authorize `/portal/_vitehub/**` and `/portal/api/_vitehub/console/**` for every method, including assets, RPC, and invocation actions. Update host policies when changing the application base or upgrading to base-aware Console routes. Absolute and protocol-relative Vite bases such as `https://cdn.example/portal/` and `//cdn.example/portal/` are asset CDN URLs; without an explicit application base, protect `/_vitehub/**` and `/api/_vitehub/console/**` at root. Relative bases (`''` or `'./'`) also use root routes. When Nitro `baseURL` matches the application base, Nitro adds it once, so the Console is at `/portal/_vitehub`. Primary Auth access routes must also use the application base; built-in Console Auth applies it automatically.

### Open the Console from the app's pages

The ViteHub tools pill shows at the bottom of the app's pages when a page has the `?vitehub` query or the `vitehub-tools` cookie. Opening the Console sets that cookie for you. When the Console is on, the pill has a **Console** button that opens the Console in a floating window, next to page tools such as [Comments](/docs/comments/configure#turn-comment-mode-on-and-off).

The link uses the same access check as the Console data routes, for any section. A person that the Console rejects does not get the link. An `authorize` result with at least one section, such as `{ sections: ['content'] }`, allows the link. With the development default, the Console and its link exist on the development server only. **Turn off ViteHub tools**, the **×** of the pill, clears the cookie and removes the pill. The ViteHub mark at the start of the pill collapses it to a small hexagon 2px from the edge of the screen, and the browser keeps it collapsed on the next pages until you select the mark again. Open windows and comment mode stay as they are. Drag the mark to dock the pill to another edge of the screen: top, right, bottom, or left, at the place where you release it. On the left and right edges the buttons stack, and windows open from the edge where the pill docks. The browser remembers the place on the next pages.

The check runs in `GET /_vitehub/page/session`. The Console serves that route and the page tools loader, so the link also works in an app without Comments. The link is only a shortcut. Every Console route checks access again.

### Start Agent Invocations

`invoke` lets the Console start Agent Invocations and run manual Schedules. It defaults to `true` on the development server and `false` in a production build. This applies to both Vite and Nuxt:

```ts
console: { auth: 'app', authorize: './server/console-authorize.ts', invoke: true }
```

Your access policy decides who can start invocations, because the invocation routes call it. A user also needs the `agents` section. Setting `invoke: false` keeps inspection available and disables Agent Invocation creation. Fixture mode always disables it.

### Impersonate users

`impersonation` lets a Console administrator open the app as one of its users, to see what that user sees. It is off by default:

```ts [vite.config.ts]
console: { auth: 'app', authorize: './server/console-authorize.ts', impersonation: true }
```

It needs app Auth with Better Auth's [admin plugin](https://www.better-auth.com/docs/plugins/admin) and the [Auth event log](/docs/auth/events), so that each start and stop has a record. Without app Auth, the build stops with `VITE_HUB_B0005`.

```ts [server/auth.ts]
import { createDatabaseAuthEventStore, defineAuth } from 'vite-hub/auth'
import { useDatabase } from 'vite-hub/database/drizzle'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'

export default defineAuth(() => {
  const { db, schema } = useDatabase('auth')
  return {
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    plugins: [admin({ adminUserIds: ['<your user id>'] })],
    events: { store: createDatabaseAuthEventStore({ db }) },
  }
})
```

Open **Auth › Users**, select a user, and select **Impersonate**. The browser signs in to the app as that user, and the app opens. To stop, open the Console again and select **Stop impersonating**. Better Auth restores your own session.

Two checks decide who can impersonate:

- The Console access policy gives the `auth` section. A read-only grant (`'auth:read'`) cannot change Auth data, and this includes impersonation.
- The app session has Better Auth's `user: ['impersonate']` permission, which the admin plugin's `adminRoles` and `adminUserIds` give.

Better Auth refuses banned users and other administrators as targets. To allow administrators, set `admin({ allowImpersonatingAdmins: true })` or give the `impersonate-admins` permission. The user panel shows the reason when Better Auth refuses a user.

The security model:

| Rule | What it means |
| --- | --- |
| Off by default | Without `console.impersonation`, the Console shows no Impersonate action, and the Auth route answers `404` to start and stop. Better Auth's own admin endpoints stay as the app configures them. |
| Short session | The session lasts `admin({ impersonationSessionDuration })` seconds, one hour by default. It never refreshes past that time, also when a client sends only the session cookie. |
| Recorded | Auth Activity shows `impersonation.started` and `impersonation.stopped`, with you as the actor. Without `events.store`, the action is off. When the log cannot record a start, the impersonation does not start. |
| No new credentials | An impersonation session cannot approve OAuth, MCP, or device clients, create API keys, register passkeys, set or change the password, change the email, phone number, or username, link or unlink accounts, read or refresh a linked account's provider tokens, change two-factor settings, create one-time tokens, or start another impersonation. These requests return `403` with `IMPERSONATION_FORBIDDEN`. |
| Not in the Console | With app Auth, an impersonation session never opens the Console. Each Console page shows **Viewing the app as …** with **Stop impersonating**, and Console data routes return `403` with `CONSOLE_IMPERSONATING`. With Console Auth or Cloudflare Access, the Console keeps its own session and the Auth section shows a banner with **Stop impersonating**. |
| Same origin | Start and stop use the Auth route, which requires the same origin and `x-vitehub-console: 1`. The **Viewing the app as …** page calls Better Auth's `stop-impersonating` endpoint, which checks the origin. |

When the session ends before you stop it, Better Auth cannot restore your own session. Sign in again.

App code can detect an impersonation session. On the server, `session.impersonatedBy` is the id of the administrator:

```ts [server/api/me.get.ts]
import { withAuth } from 'vite-hub/auth/server'

export default withAuth((_event, { session, user }) => ({
  id: user.id,
  impersonatedBy: session.impersonatedBy ?? null,
}))
```

In Vue, `useUserSession()` gives `impersonatedBy` and `stopImpersonating()`, so the app can show its own banner:

```vue [components/ImpersonationBanner.vue]
<script setup lang="ts">
import { useUserSession } from 'vite-hub/auth/vue'

const { impersonatedBy, stopImpersonating, user } = useUserSession()

async function stop() {
  await stopImpersonating()
  window.location.assign('/_vitehub/auth/users')
}
</script>

<template>
  <div v-if="impersonatedBy" role="status">
    Viewing the app as {{ user?.email }}
    <button type="button" @click="stop">Stop impersonating</button>
  </div>
</template>
```

### Manage Connections in production

On the development server, Console users can connect [Connections](/docs/connections), set API keys, refresh tokens, and disconnect. A production build mounts the Connections section and its management routes only with `connections: { management: true }`:

```ts
vitehub({
  connections: { management: true },
  console: { auth: 'app', authorize: './server/console-authorize.ts' },
  database: true,
  preset: 'node',
})
```

Every user that passes the Console access policy with the `connections` section can then manage every Connection. Restrict the policy to the people who own the provider accounts.

In `vite dev`, a Console without sign-in (`local` access, or `console: { auth: false }`) answers only loopback requests. A request whose `Host` is not `localhost`, `127.0.0.1`, or `[::1]`, or whose peer address is not loopback, gets `403` with `CONSOLE_LOOPBACK_ONLY`. Production servers are not affected, so set `console.auth` or `console.authorize` for them.

Console RPC requests must come from the same origin. The RPC route rejects opaque origins and browser requests marked `same-site` or `cross-site`. Browser Fetch Metadata permits same-origin requests through reverse proxies. When that metadata is absent, the RPC route compares the `Origin` header with the request URL. Hosts must reconstruct the public request origin for older browsers that send `Origin` without Fetch Metadata.

Browsers can omit both headers on HTTP origins. Requests with neither same-origin Fetch Metadata nor an `Origin` header must send `x-vitehub-console: 1`. A foreign browser page cannot add this header without a CORS preflight, which the RPC route rejects. The built-in Console client adds it automatically. Server clients must add it when they send RPC calls without origin headers. The marker is not a credential. All requests still require the configured authentication and authorization.

The `agents.invoke` operation accepts an Agent name and the fields of `ConsoleAgentInvocationInput` from `vite-hub/console`. The input requires a non-empty `prompt` and can include a configured `invokerProfileId` and prior `messages`.

```ts
import { createMessage } from 'vite-hub/agent'
import type { ConsoleAgentInvocationInput } from 'vite-hub/console'

const body = {
  messages: [
    createMessage({ role: 'user', text: 'Which receipt date?' }),
    createMessage({ role: 'assistant', text: 'The promised date.' }),
  ],
  prompt: 'And if that is blank?',
} satisfies ConsoleAgentInvocationInput
```

History must contain valid ViteHub Messages with `user` or `assistant` roles and unique IDs. Parts must be `text`, `file`, `image`, or `audio`. The Console preserves message metadata and appends the new prompt as a user Message. It rejects malformed Messages, `system` or `tool` roles, and other parts before starting the Agent. This includes tool calls, tool results, and approval parts nested in user or assistant Messages. Omit `messages` for a prompt-only invocation. Each request creates a new invocation; history does not resume a previous runtime session.


### Cancel a running session

A pending or running session shows **Cancel session** in its header when the Console has invoke access for the session's Agent. The action uses the same `invoke` permission as starting an Agent Invocation. Without it, the button is hidden and the `invocations.cancel` operation rejects the call with status 403.

The Console calls `invocations.cancel(id)` on the Agent's journal. A run in the same process stops at once. A run in another process reads the request at its next claim renewal, within 10 seconds. When the Driver cannot stop the run, the header shows `Cancel requested, not enforced by <driver>`. The session stays running until the Driver returns. See [Cancel an invocation](/docs/agents/invocations#cancel-an-invocation) for each Driver.

A finished session shows **Abort stale execution**. This sends an abort signal to any execution still registered in the Console process without changing the terminal journal. The result reports local delivery and any Driver that cannot enforce abort. If no local execution receives the signal, the header says so. A journal that did not keep a pending or running request returns status 503.

Nuxt does not need an SEO module for the `X-Robots-Tag` default. If the app already uses `@nuxtjs/robots` or `@nuxtjs/seo`, add route metadata so its robots and sitemap modules also know that Console pages are not indexable:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  routeRules: {
    '/_vitehub': { robots: false },
    '/_vitehub/**': { robots: false },
  },
})
```

Do not use `robots.txt` as access control. A crawler can ignore it, and a disallowed URL may still be listed without its contents.

Read [Auth](/docs/auth/server-api#authorize-access-routes) for sign-in redirects and the complete callback contract.

## Know what the Console stores

When Agents are configured and no journal is set, the Console installs a fallback Agent Invocation journal at `.vitehub/data/console.sqlite`. It retains invocation records and selected searchable text, including prompts, messages, final text, progress updates, and generated session titles. A KV-only Console does not install the Agent journal or Agent read endpoints.

Console image uploads use the configured Blob store. Before each fresh upload, the Console retries at most 100 pending rollback records. Malformed batch records move to `_vitehub/console/quarantine/batch/<id>` with their original contents preserved. Fresh uploads continue, but stored attachment references remain unavailable while any quarantine record exists because its deletion ownership is unknown. Existing retained image bytes are not deleted by quarantine.

To repair a quarantined record, recover its original attachment UUIDs from trusted storage history and write their JSON array (1–10 UUIDs) to the cleanup prefix that matches the quarantine record: use `_vitehub/console/cleanup/batch/<id>` for new quarantines and `vitehub-console-attachment-cleanup/<id>` for legacy quarantines. After a later upload successfully drains that cleanup record, remove the corresponding quarantine object through the Blob provider. Keep the quarantine record if its original UUIDs cannot be recovered; guessing could delete retained images.

Set `observations` on the Console configuration when the fallback journal needs larger records or more time to drain pending writes:

```ts
console: {
  auth: 'app',
  authorize: './server/console-authorize.ts',
  observations: {
    maxCount: 1024,
    maxStringLength: 131072,
    maxBytes: 16777216,
    flushTimeoutMs: 10000,
  },
}
```

These limits apply only to the Console fallback journal. If discovered Agent Definitions or `agent.invocations` configure a shared journal, set its limits in that journal's `observations` option instead. See [Agent Invocations](/docs/agents/invocations) for defaults and supported bounds. Larger limits increase record storage and memory use.

Set `VITEHUB_CONSOLE_DATABASE_URL` when the journal belongs on another volume or libSQL endpoint. Relative `file:` paths resolve from the ViteHub project root:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=file:/var/lib/my-app/console.sqlite
```

Authenticated libSQL endpoints also require `VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN`:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=libsql://my-database.turso.io
VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN=secret-token
```

The fallback journal keeps every terminal record by default. Set `retention` on the Console configuration to remove old terminal records by age, count, or size. All limits that are set apply together, and the oldest terminal records go first:

```ts
console: {
  auth: 'app',
  authorize: './server/console-authorize.ts',
  retention: { maxAge: '14d', maxSize: '30%' },
}
```

`maxAge` takes a duration such as `'14d'` or a number of milliseconds. `maxRecords` takes a positive integer. `maxSize` takes a size such as `'500MB'`, a number of bytes, or a percent of the volume that holds the journal file, such as `'30%'`. A percent counts only the journal file, not the other files on that volume. `maxSize` bounds the live data of the whole database file, so keep the journal in its own file. A file created before this release keeps its largest size until a `VACUUM` rebuilds it; its free pages are reused for new records. An invalid limit fails the build with `VITE_HUB_B0015`. The D1 fallback does not support `maxSize`, because D1 reports the size of the whole app database, and fails the build with `VITE_HUB_B0016`. See [Agent Invocations](/docs/agents/invocation-storage#use-a-custom-store) for how each limit runs.

In production, the operator must still decide how long to keep records that may contain sensitive data. Workflow, Queue, and Schedule inspection do not use the journal. Workflow and Queue do not expose run or message history because ViteHub does not yet have provider-independent contracts for listing that operational data. The Schedule page lists the discovered Schedule Definitions. Definitions with `manual: true` show a run action when Console invocation is enabled; use [`vitehub schedule`](/docs/development/cli#run-and-inspect-schedules) to run them or list recorded runs, in development or on a deployment with `--url`.

The fallback applies only when no journal is set. A journal from `defineAgent({ invocations })` or from the app-wide `agent.invocations` option remains authoritative. Its sessions are not copied into `console.sqlite`. The Console reads that journal instead, so development uses one journal. An Agent with `invocations: false` records no sessions.

The automatic fallback also requires `defineAgent` from `vite-hub/agent`. Definitions imported directly from `@vite-hub/agent` must configure their own `invocations` store.

The Agent Console uses an invocation journal configured on the discovered Agent Definition. Configure the same journal on every discovered Agent when the Console includes more than one. Set [`agent.invocations`](/docs/agents/invocation-storage#use-one-journal-for-every-agent) to give all of them the same journal. Distinct journals fail during runtime setup because the Console exposes one combined query interface.

When no Agent Definition configures a journal, the Console falls back to local SQLite at `.vitehub/data/console.sqlite`. This fallback is suitable for development and Node deployments with durable local storage. It is local to one replica and does not survive replacement unless the host persists that path. Cloudflare, Netlify, Vercel, and Deno production deployments should configure a durable hosted invocation journal instead.

The Console sends every read through the RPC route at `/_vitehub/rpc/**`. Its internal request contract uses `GET` semantics for bounded listings and metadata, and JSON-body `POST` semantics to read a selected KV value without putting an opaque key in the request URL. The POST body of a KV value read names the key without putting it in the URL. KV writes use the same route with an `action` (`set`, `del`), and Blob uploads and deletes with `put` and `del`; those run the `kv.set`, `kv.del`, `blob.put`, and `blob.del` operations. Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

KV inspection calls the configured store's paginated `list`, `get`, and `has` operations. It never calls `set`, `del`, or `clear`. Each key page returns at most 200 entries, and the Console passes the provider's opaque cursor when you load more. Selected values are rendered as text or formatted JSON and truncated at 256 KiB in the response. Listing and reading can still count as provider operations even though they do not change data.

Blob inspection calls only the configured store's `list` operation. It returns at most 100 objects initially and 250 per request, follows provider cursors automatically while hidden ViteHub objects are skipped (up to ten provider pages per request), and follows the returned cursor when you choose **Load more**. It supports a pathname prefix. ViteHub keeps the objects it writes for itself, such as Workspace history and Console attachments, under `_vitehub/`. The Blob section hides those objects by default. Turn on **Show ViteHub files** to list them. A page can have fewer objects than its limit when it skips ViteHub objects. It does not call `get`, `head`, `serve`, `sign`, `put`, or `del`. Object contents and provider URLs never enter the Console response. Listing can still incur provider requests and cost.

## Inspect the Agent context

Open an Agent Invocation and expand **Captured setup** to inspect the context resolved for that run. The Console shows the final instruction blocks and the model-visible tools, including each tool's description, input JSON Schema, and output JSON Schema when one is available. This is the post-composition contract after the Agent Definition, Capabilities, and runtime tool resolution have been applied, so it also covers dynamic tools whose contract cannot be generated into static documentation.

Invocation journals are metadata-only by default. In that mode, Captured setup includes tool names but omits instructions, descriptions, and schemas. Configure the Agent's invocation journal with `configuration: 'content'` to retain the resolved context independently of other trace content. `content: 'content'` also retains it. Large journal observations remain subject to ViteHub's trace bounds and are marked when truncated. That context can contain secrets or customer data contributed by application code, so use the same access, retention, and encryption controls as prompts and model output. See [Agent Invocations](/docs/agents/invocation-storage#store-invocation-history) for configuration details.

## Inspect Skills

Open **Skills** to browse the files bundled with each discovered Agent Definition. The tree includes colocated `skills/` files and Skills added with `agentWithSkills()`. Select a file to read its Markdown preview or its source. Markdown links to other bundled files open those files in the tree. The URL keeps the selected Agent and file.

**Skill index** opens [ViteHub's published Skill index](https://vitehub.dev/.well-known/skills/index.json). This public index is separate from the current app's bundled Agent Skills.

This view reads the current Agent Definition. It does not start an invocation or refresh a Source. Inspect Source-mounted Skills in a session's Workspace. Text previews are limited to 512 KiB; binary files remain listed but cannot be previewed.

## Inspect usage

Open **Usage** in the Console sidebar to inspect provider-reported tokens and cost across the past 24 hours, 7 days, 30 days, or 90 days. The dashboard groups completed Agent Invocations by time and model. A warning appears when the bounded journal scan reaches 10,000 records or a recorded finish event is truncated, so partial totals are never presented as complete.

Session details also show the normalized usage record for one invocation. Add the [Usage Capability](/docs/agents/capabilities/usage) when the provider needs an explicit usage request, estimated cost, or a typed Agent Usage Record at finish. Providers that report usage without the Capability still appear because the recorded finish event is authoritative.

The Console does not calculate missing provider data. Token counts, model metadata, and provider-reported cost remain absent when the provider does not report them. Global and per-bucket model breakdowns sort by descending total tokens, then by model name.

## Fix common failures

| Symptom | Check |
| --- | --- |
| `/_vitehub` returns `404` | Confirm that `console` is set with an `auth` choice, then restart the development server. Omitted and false configurations register no route. |
| Agents is absent from the Console home | Configure `agent`. The Console only lists primitives active in the same ViteHub configuration. |
| KV is absent from the Console home | Configure `kv`. The Console only lists stores from the active KV configuration. |
| A KV key page stops at 200 entries | Load the next page or enter a key prefix to narrow the list. The Console does not fetch values until selection. |
| Blob is absent from the Console home | Configure `blob` with a preset that supports Blob or an explicit Blob store. |
| Blob inspection returns a provider error | Check that the deployed Console runtime has permission and credentials to list the configured store. |
| Databases is absent from the Console home | Configure `database`. The Console catalogs Database Definitions only when the integration is enabled. |
| Rate Limits is absent from the Console home | Configure `rateLimit` and use statically declared `requireRateLimit()` policies. |
| Workspaces is absent from the Console home | Configure `workspace` and add a discovered Workspace Definition. |
| Sandbox Tasks is absent from the Console home | Configure `sandboxTask: true` with a deployment preset that supports Sandbox. |
| KV inspection returns a provider error | Check that the deployed Console runtime has permission and credentials to read the configured store. Read-only Console requests still perform provider reads. |
| Agents opens but has no sessions | Invoke a discovered Agent. Confirm it uses the framework fallback instead of a separate `invocations` store. |
| Sandboxes is absent from the Console home | Configure `sandboxTask: true` with a deployment preset that supports Sandbox Tasks. |
| A production build fails with `VITE_HUB_B0014` | Set `console.authorize` to a server file that default-exports `defineConsoleAuthorize()`. |
| `console: true` reports missing app Auth or Console access policy | Enable `auth: true` and authorize the Console routes in the app Auth Definition. The shorthand uses app Auth; use `console: { auth: false }` only when you want no sign-in. |
| ViteHub reports that `console.auth` is required (`VITE_HUB_B0004`) | Add `auth` to the `console` object. Use `false`, `'app'`, or a Console Auth config. |
| `auth: 'app'` fails with `VITE_HUB_B0005` | Set `auth: true` and add a discovered Auth Definition, such as `server/auth.ts`. |
| `auth: 'app'` fails with `VITE_HUB_B0006` | Set `console.authorize`, or add Auth access routes with an `authorize` callback for the routes in the message. |
| The build or server warns that `auth: false` has no sign-in | Add `console.authorize`, or set `console.auth` to `'app'` or a Console Auth config. |
| Console data routes return `500` with "console.authorize must return" | Return `true`, `false`, a `Response`, or `{ sections: string[] }` from `authorize`. Create the `Response` with the global `Response`. An object shaped like a Response, or a Response from another Fetch implementation, is an invalid result. |
| Agent Console startup fails on a hosted preset | Set `agent.invocations: 'database'`, or attach one durable Agent Invocations journal to every discovered Agent Definition. The local SQLite fallback requires a writable, persistent filesystem. |
| The page returns `401` | Sign in through the Auth provider configured by the host. |
| The page returns `403` | Check the `authorize` callback and the current user's role or permission. |
| A section is missing or returns `403` | `console.authorize` returned `{ sections }` without that section id. |

### Console error codes

Each failed Console request returns JSON with a stable `code`, a `message` that says why it failed, a `fix`, and a `docs` link. Console RPC failures also keep `ok: false` and `status`. The Console shows these fields with one next step: sign in again, reload, try again, or read the docs. It offers a retry only when a retry can succeed.

| Code | Status | Fix |
| --- | --- | --- |
| `CONSOLE_SIGN_IN_REQUIRED` | `401` | Sign in again. |
| `CONSOLE_ACCESS_DENIED` | `403` | Sign in with an account that the access policy allows. |
| `CONSOLE_MANAGER_REQUIRED` | `403` | The session has no user id, so a management action cannot name its manager. Make sure the Auth Definition that protects the Console returns a user with an id. |
| `CONSOLE_IMPERSONATING` | `403` | This browser uses an impersonation session. Stop impersonating to get your own session back. |
| `CONSOLE_DEVELOPMENT_ONLY` | `403` | Rebuild and deploy with an explicit `console.auth` choice. Use `console: { auth: 'app' }` with the Primary Auth Definition, or configure a Console Auth session. Set `console.authorize` to restrict who may use it. |
| `CONSOLE_ORIGIN_REJECTED` | `403` | Open the Console from its own URL. Proxies must forward the public `Host` and `Origin` headers. |
| `CONSOLE_ACCESS_NOT_CONFIGURED` | `500` | Build the app with the ViteHub plugin. |
| `CONSOLE_AUTHORIZE_REQUIRED` | `500` | Set `console.authorize`. |
| `CONSOLE_AUTH_NOT_CONFIGURED` | `500` | Add an Auth Definition, or configure Cloudflare Access. |
| `CONSOLE_MCP_ORIGIN_REQUIRED` | `503` | Set `vitehub({ publicUrl })` or `console.mcp.resource`, so [MCP OAuth](/docs/development/mcp#set-up-oauth) has an origin that a request cannot change. |
| `CONSOLE_MCP_OAUTH_INCOMPLETE` | `503` | Add `jwt()` and `oauthProvider({ resources, scopes })` to the Auth, as in [Set up OAuth](/docs/development/mcp#set-up-oauth). |
| `CONSOLE_CONNECTIONS_MANAGEMENT_UNAVAILABLE` | `404` | Set `connections: { management: true }` for production. |
| `CONSOLE_ENV_MANAGEMENT_UNAVAILABLE` | `404` | Give the Env declaration a management bridge. |
| `CONSOLE_REQUEST_INVALID` | `400`, `405`, `413` | Reload the Console. Deploy the Console and the server from the same build. |
| `CONSOLE_NOT_FOUND` | `404` | Reload the Console. |
| `CONSOLE_CONFLICT` | `409` | Reload, then try again. |
| `CONSOLE_UNAVAILABLE` | `408`, `429`, `502`–`504` | Wait, then try again. |
| `CONSOLE_REQUEST_FAILED` | `500` | Try again, then read the server logs. |

A Console route that fails with its own diagnostic keeps that code, for example `VITE_HUB_R0065`. Connections and Env management routes keep their `CONNECTION_*` and `ENV_BRIDGE_*` codes and add `fix` and `docs` to the error body.

Use [Agent Invocations](/docs/agents/invocations) for custom stores and invocation lifecycle behavior. Use the [UI parts](/docs/ui) such as [Trace](/docs/ui/trace) and [Code block](/docs/ui/code-block) when you build an application-owned inspection page instead of mounting the complete Console.

### Image upload boundaries

Console image uploads require `console.invoke` to be enabled. The Agent and invoker profile selected when you submit stay fixed while images upload. If you switch Agents, the pending request does not redirect the input or open its result in the new Agent view.

Images must be PNG, JPEG, WebP, or GIF, with at most ten images and 10 MiB combined per invocation. Blob storage must return an HTTP or relative serving URL. The Console rolls back new uploads if storage or invocation setup fails before the Agent takes ownership. Images handed to an Agent remain under `_vitehub/console/attachments/` and follow your Blob storage retention policy.

## Inspect capabilities

Open the right panel's tab chooser and select **Capabilities**. Select a Capability to inspect its recorded data and tools. MCP groups tools by server and preserves original tool names and schemas. Title shows its generation settings, progress, and result. Other Capabilities have a default tools and configuration view.

The panel reads the selected Invocation's snapshots. It does not run MCP discovery or title generation. Missing or truncated capture is marked. Developers can [contribute a read-only view](/docs/agents/capabilities/custom#contribute-an-inspection-view) with the shared JSON Render component catalog.

## Work from a page

After opening the Console, return to any application page. The ViteHub pill stays available while its hint cookie is present. You can also open a page with `?vitehub`. The server checks each tool's access; the cookie grants no permissions. Ordinary signed-out visitors do not get the editor.

Choose **Console** to open it in a floating window. **Content** appears only when Content is installed and your Console permissions include the full `content` grant. A `content:read` grant keeps Content available through **Console**. Choose **Select field**, then a page element marked with `contentField()`, to open that document in the same Content editor. While you select, an open Content window moves out of the way. <kbd>Esc</kbd>, a second **Select field**, or a click outside a field cancels and brings the window back. A click while you select never follows a link on the page. When the window was minimized, it stays minimized while you select, and only a picked field opens it. You can also browse collections with the keyboard inside the Content window. Content's own read, write, and publish policies still apply.

Expand or minimize the window without losing the selected document or unsaved text. On a phone the editor fills the available screen. Client-side page navigation leaves the editor open on its current document. A full page reload cannot retain unsaved memory; the editor asks before leaving when it has unsaved changes. Window size and the selected editor route are remembered locally; document values are not stored by the pill.

The editor loads on first use. Production embedding uses a same-origin iframe and requires an accepted Console session. A normal Console page still denies framing; `?embed=1` permits same-origin framing only after the Console access check. Hosts must permit the same-origin frame in their own Content Security Policy.

Comments uses the same expandable window for the current page's thread list and replies. When the Content editing tool is available, Comments' **Edit** action opens the document editor. Otherwise its existing plain-text field editing remains available according to the Comments and Content policies.

## Inspect logs

[Logs](/docs/logs) uses Evlog for request capture, structured fields, redaction, sampling, and drains. Explorer and Stream keep selected event data in the right inspector. The CLI reads the same source with `pnpm vitehub logs list --level error --json`.

[Get started](/docs/logs/get-started) with a temporary development buffer, or [connect an existing backend](/docs/logs/configure#read-an-existing-backend) for production. Follow polls the newest page every two seconds. It does not guarantee delivery of every event. See [limits and errors](/docs/logs/limits-and-errors) for retention and inspection limits.
