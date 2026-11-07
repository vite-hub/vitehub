---
title: Console
description: Enable the Console, inspect configured primitives, and protect its routes.
navigation.order: 32
navigation.group: Local tools
icon: i-lucide-monitor-dot
---

The ViteHub Console is a page in your app that shows the primitives you turned on. It is off by default. Enable it, start the app, and open `/_vitehub`.

Agents reach the same data through the [MCP endpoint](/docs/development/mcp) at `/_vitehub/mcp`.

Each Console call is one same-origin `POST` to `/_vitehub/rpc/__call` with `{ operation, input }`. An [operation](/docs/development/operations) is a named action, such as `invocations.list` or `content.publish`. The CLI calls the same route, so it works the same on development servers and production hosts.

The sections are Auth, Env, Connections, Agents, Channels, Usage, MCP client, Logs, Content, Comments, Blob, Databases, Email, KV, Rate Limits, Sandbox Tasks, Workspaces, Workflows, Queues, and Schedules. The home shows a grid of configured primitives, with the last one you opened first (the browser remembers it). A section replaces the sidebar with its own navigation. **All sections** goes back home. **Search console**, <kbd>⌘</kbd> <kbd>K</kbd>, or <kbd>/</kbd> opens a command palette with sections, their pages, Content documents, and, when Agents is on, Agents and kept sessions.

- **Channels** lists the Channels of your Agents, their threads, and each conversation with its attachments and the runs that answered. You can download a conversation as Markdown or JSON. A warning shows when transcripts are not durable. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).
- **Content** shows when `server/content.ts` defines document collections. It saves drafts, publishes, and restores revisions. `content.can()` decides what each user may do. See [Edit Content in the Console](/docs/content/console).
- **Comments** shows when the app turns on [Comments](/docs/comments/configure#turn-comments-on-in-a-vitehub-app). It lists the threads the team left on the app's pages. Opening the Console turns on the [ViteHub tools pill](#open-the-console-from-the-apps-pages), with the Comments toolbar, on those pages. See [Comment as the Console team](/docs/comments/configure#comment-as-the-console-team).
- **Blob** lists stores and pages of object metadata. It does not download contents or show provider URLs. It uploads (up to 8 MiB) and deletes objects with `blob.put` and `blob.del`.
- **Database** lists found Definitions (the files that declare each resource), their source, definition mode, and table names, without connecting to a database. When the schema is imported or spread, the Tables field says so.
- **KV** lists stores and keys. It fetches a value only when you select its key. It edits and deletes with `kv.set` and `kv.del`.
- **Rate Limit** lists policies and their source locations. It reads or resets the counter of a key you enter with `rate-limit.peek` and `rate-limit.reset`.
- **Sandbox** lists Definitions without starting runtime resources.
- **Workspace** lists Definitions and source roots without starting workspace stores, Sources, files, or processes.
- **Workflow** and **Queue** list Definitions and their source without loading the Definition modules.
- **Schedule** shows one table of Schedule Definitions with their cron expression, time zone, and manual state. It runs a Definition that sets `manual: true`. `vitehub schedule runs <name>` lists its recorded runs.

> [!WARNING]
> Console data can contain user prompts, model output, tool activity, Blob metadata, provider metadata, and stored KV values. Protect the Console before you put it on a production URL.

### Section pages and URLs

A section can have more pages than its main view. Content has a dashboard, a Settings page when it defines a singleton, and a Media page when Blob is on. Each page has its own URL, so links, reloads, and Back work:

| URL | Opens |
| --- | --- |
| `/_vitehub/content` | The section's index page, the Content dashboard. A section without one opens its main view. |
| `/_vitehub/content/-/media` | Another page of the section. |
| `/_vitehub/content/-/settings` | The singletons of the section, such as site settings. |
| `/_vitehub/content/posts` | The `posts` collection in the main view. |
| `/_vitehub/content/settings` | The editor of the `settings` singleton. |
| `/_vitehub/content/posts/2026/launch` | The document `2026/launch` of `posts`. |

The `-` segment keeps pages apart from collections, so a collection named `media` still works. `/_vitehub/content/-/dashboard` redirects to `/_vitehub/content`. Vite and Nuxt register the same routes.

Pages use the access of their section. `{ sections: ['content'] }` in `console.authorize` allows the dashboard, Settings, Media, and every collection. There is no page scope. The owner policy, such as `content.can()`, still decides each action.

The sidebar header button collapses it to icons. The browser keeps the state and width.

### Page state in the URL

Each page keeps its view in the query string. A reload, a shared link, Back and Forward, and **Open in new tab** in the floating window open the same view. A selection, a tab, or a new page of results adds a history entry. A search, a filter, or a sort replaces the current entry. Default values stay out of the URL, and the Console ignores unknown values.

| Page | Query parameters |
| --- | --- |
| Agents | `q` searches session titles and IDs. `capability`, `triggeredBy`, `details=open` or `details=max`, `tab`, `file`. The Agent and session are in the path. `sessions=open` opens the session list on a narrow screen at load. |
| Auth | `q`, `filter`, `offset`, `user`, `org`. Activity: `group`, `userId`, `cursor`. |
| Blob | `store`, `folder`, `file`, `q`, `type`, `vitehub=1`. |
| Channels | `agent`, `channel`, `thread`, and `q` for the thread search. |
| Comments | `q` searches the page, the author, and the text. `filter.status`, or `filter` in the operation view. |
| Connections | `q`, `connection`, `tab`. |
| Content | List: `q`, `state`, `sort`, `filter.<field>`. Editor: `preview`, `panel`. Media: `folder`, `file`, `q`, `type`. |
| Databases | `q`, `sort`, `dir`, `offset`. The database and the table are in the path. |
| Env | `q`, `source`, `variable`, `manage=1`, `tab`. |
| KV | `store`, `key`, `q`. |
| Logs | `q`, `level`, `view`, `entry`. |
| Queues, Schedules, Workflows, and other catalogs | `q` searches names. `definition`, or `record` for a record table. Rate Limits: `key`, the key that was read. |
| Email and other record tables | `q` searches the id and every cell, such as the recipient. `filter.<column>` filters a column marked `filter: true`, such as `filter.delivery=Failed`. |
| Skills | `agent`, `path`. |
| Usage | `window`, `section`, `metric`, `breakdown`, `agent`, `status`, `search`. |

### Search

<kbd>⌘</kbd> <kbd>K</kbd> or <kbd>/</kbd> opens search from any Console page.

| Group | Items |
| --- | --- |
| Content | Drafts of every collection you may read, matched by title, id, fields, and body. An empty query shows recent changes. |
| Actions | Commands of the current page, **New** for each collection you may edit, **Publish all changes** when you may publish, and theme commands. |
| Go to | The Overview, each section, its pages, and its collections. |

Items also match aliases, such as `images` for Media and `deploy` for **Publish all changes**. <kbd>Enter</kbd> opens the highlighted item. <kbd>⌘</kbd> <kbd>Enter</kbd> opens it in a new tab. **Publish all changes** lists the changes it will publish. Choose **Publish N changes** to publish exactly those drafts, or press <kbd>Backspace</kbd> on an empty query to go back.

### Update ready

Each Console build has an id, which changes only when the Console catalog or client changes. An open Console compares its id with the deployed one once a minute and when the tab becomes visible. When they differ, choose **Update ready** at the bottom of the rail to reload. The sections response returns the deployed id as `build`.

## Enable the Console

Set `console` in the ViteHub options. `console.auth` chooses who can open it, and every environment must set it:

| `auth` | Who can open the Console |
| --- | --- |
| `false` | Anyone who can reach `/_vitehub`. Use it on your own machine, or behind a host that already checks every request. |
| `'app'` | Users with a session from the app [Auth](/docs/auth). |
| `{ ... }` | Users of a separate Console Auth: inline GitHub sign-in, a Console Auth server file, or Cloudflare Access. |

The Console does not turn on [Comments](/docs/comments). Add `server/comments.ts` or set `comments: true` to get the **Comments** section. Comments turns on the Database when `database` is unset. Create its tables once with `vitehub db generate` and `vitehub db migrate`. With `database: false`, Comments fails the build: `VITE_HUB_B0018` for the `comments` option, `COMMENTS_B0001` for a `server/comments.ts` file.

For local development, use `auth: false`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    agent: true,
    blob: true,
    console: { auth: false },
    preset: 'cloudflare',
    kv: true,
    schedule: true,
    workflow: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    agent: true,
    blob: true,
    console: { auth: false },
    preset: 'cloudflare',
    kv: true,
    schedule: true,
    workflow: true,
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
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
:::
::

A standalone Nitro 3 app adds Nitro after ViteHub. The Console and its UI ship inside `vite-hub`, so you install no other package.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    agent: true,
    console: { auth: false },
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [
    vitehub({
      agent: true,
      console: { auth: false },
      preset: 'node',
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
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
:::
::

The Console has its own styles. It does not need Nuxt UI or Tailwind, and your app's theme, fonts, and layouts do not change it.

Restart the development server after you change the option. Open `http://localhost:3000/_vitehub` with your app's origin and port.

### Open the Console in DevTools

On a development server, the Console is also a **ViteHub Console** entry in your app's DevTools:

| App | Where |
| --- | --- |
| Nuxt | A tab in Nuxt DevTools 3 and 4. |
| Vite with [`@vitejs/devtools`](https://devtools.vite.dev) | An entry in the Vite DevTools dock, which Devframe renders. |

The entry shows the `/_vitehub` page in a frame. In development, same-origin frames may show the page. A production build refuses frames of a normal Console page. Only the [page window](#work-from-a-page) frames it, with `?embed=1`, after the Console access check.

With independent Console Auth, the sign-in button opens in the main browser page. Open DevTools again after you sign in.

`console: true` reuses the app Auth Definition and its server access policy. Set `auth: true` and allow the Console routes in `server/auth.ts`, as shown below. A `console` object still needs an explicit `auth`.

App Auth and the Console must use the same public origin, with the same protocol and port. The Console rejects a different Auth `baseURL` before sign-in starts. When the app's Auth runs on another origin, serve Auth on the Console origin or use independent Console Auth.

> [!WARNING]
> `auth: false` also works in a production build. The build and the server log a warning, because anyone who can reach the route can read Console data. Before you deploy, add `authorize` or choose another `auth`. See [Protect the Console route](#protect-the-console-route).

When `console` is missing or `false`, ViteHub registers no Console page, RPC route, Nitro plugin, or public asset path. The host returns its normal not-found response.

## Inspect environment declarations

Env searches declared Server Env variables and filters them by source. A variable shows its provider, secret flag, and whether it is required or has a default. Host environment means process environment variables and host runtime bindings.

Env does not read secret values, call providers, or check credentials. It does not list undeclared host variables. Values and defaults stay hidden. Change host values in your deployment configuration, and provider values in their connected store. Set `env: false` in the ViteHub options to turn off Env and its section.

## Manage Connections

Connections shows each [Connection](/docs/connections) (a stored login to an outside service) from `server/connections/`, with its status, type (**OAuth** or **API key**), and account. A row that needs action shows one button:

- **Connect** or **Set key** when it is not connected.
- **Reconnect** or **Replace key** when it stopped working or misses declared scopes.

Missing scopes and pending approvals show only when there are some. The Console does not create Connections. Add a Connection Definition to `server/connections/`, then connect it here.

**Connect** opens the provider consent page in the same tab. The result page shows the outcome, or the error code and fix, and links back. Select a row to see its details:

- **Connection** shows the account, scopes, and last error. **Connect** or **Reconnect** starts the consent flow and returns to the Console. For an API key, **Set key** or **Replace key** stores a new key. The Console sends it only over HTTPS or to a loopback host. **Refresh token** refreshes the access token. **Disconnect** deletes the grant and revokes it at the provider when the provider supports it.
- **Access** shows the Definition's rules for server code, routes, and Agents.
- **Activity** lists Agent calls, writes, denials, failures, and account changes, newest first. Agent calls link to their Invocation. Activity keeps no request or response bodies or headers.

The Console registers `POST /_vitehub/connections`, `GET /_vitehub/connections/connect/:name`, and `GET /_vitehub/connections/callback` only when Connections is on. Each route runs the Console access check, in development and production. Actions record who did them:

- Console Auth or app Auth: `user:<id>` of the signed-in user.
- `auth: false`: `user:open`.
- Cloudflare Access: `user:cloudflare-access`.

When `console.authorize` returns `{ sections }`, these routes also need the `connections` section. Nuxt apps do not have the Connections section.

**Connect** stores a single-use OAuth `state`. The GET connect route sets a `state` cookie and a return-page cookie, then redirects to the provider, which returns to the GET callback route. The callback uses up the `state` and checks the cookie and the manager before it saves the grant. A `state` from another manager returns `403`. Proxies must forward both GET routes with query strings and cookies, and the POST route. With Vite `base`, these routes use that prefix.

## Connect to MCP servers

Set `console.mcpClient` to `true` to add the MCP client section. It runs on the server and connects to MCP servers over Streamable HTTP as the person signed in to the Console. It lists and calls their tools, reads their resources, gets their prompts, and shows each result as the server sent it.

```ts
vitehub({
  console: { auth: "app", mcpClient: true },
})
```

This section is a client. [ViteHub MCP](/docs/development/mcp) is the server that the Console serves at `/_vitehub/mcp`, with no option needed.

The section lists ViteHub MCP and the MCP server that the app announces in its [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata at `/.well-known/oauth-protected-resource`, such as its own `/mcp`. **Connect** also takes the URL of another server or a path on this app. URLs must use HTTPS. Plain HTTP works only for this app and `localhost`. The same rule applies to OAuth endpoints and every redirect.

### Open ViteHub MCP

ViteHub MCP needs no sign-in or token. Each request carries the session of the Console request that started it: the session cookie, the `Authorization` header, or the Cloudflare Access token. The Console stores none of them and sends them only to `/_vitehub/mcp` on the same origin and mount. ViteHub MCP lists the tools of your Console sections, as an Agent that connects as you gets them. One session is one account, so **Connect** opens the same connection again.

### Sign in with OAuth

Without a token, the Console first connects without credentials. When the server answers `401`, it starts the [MCP authorization flow](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):

1. It reads the protected resource metadata that the `WWW-Authenticate` header names. Then it reads the metadata of the authorization server, with RFC 8414 or OpenID Connect discovery.
2. It registers a public client with dynamic client registration (RFC 7591). It reuses registrations for the same MCP resource and callback URL. Each connection keeps the registration of its own sign-in, also when first sign-ins overlap.
3. The browser opens the authorization URL with PKCE `S256`, `state`, and `resource` (RFC 8707). The authorization server sends the browser back to `/_vitehub/mcp-client/callback`, and the Console exchanges the code on the server. The Console checks a supplied `iss` (RFC 9207) against discovery, and requires it when the server advertises support.
   The scope is the one the `401` asked for, else the scopes of the protected resource metadata. When the authorization server lists `offline_access`, the Console asks for it so the server can issue a refresh token. OpenID Connect then asks for consent at each sign-in (`prompt=consent`).
4. When the MCP server rejects an access token, the Console uses its refresh token. Without one, the connection shows **Signed out**, and **Sign in again** starts a new sign-in.
5. **Disconnect** ends the MCP session. When the authorization server names a revocation endpoint, the Console also revokes the tokens there (RFC 7009).

The app's own `/mcp` usually uses the app's Auth on the same origin, which sees this browser's session, so a signed-in person only approves the client. A server that keeps approvals skips that step next time, unless the sign-in asks for `offline_access`. The Console does not skip the approval, because the app checks that record on each request.

When a server has no OAuth, choose **Token** and paste a personal API key or another bearer token. The Console sends it in the `Authorization` header.

### Connect as several accounts

Each connection has its own grant and MCP session, so you can open one server as several accounts. The sidebar groups connections by server. **Add an account** adds another.

- **Sign in as someone else** sends `prompt=login`, so the authorization server shows its sign-in form even when this browser is signed in.
- With `console.auth: "app"`, the Console and an authorization server on the same origin share one session. Signing in as someone else there would sign the Console in as that person too, so the Console turns the option off for those servers. Use the other person's token, or open the Console with `auth: false` in development.

**Run as** sends the same tool call, resource read, or prompt through other connections to the server and shows the results side by side, to compare what each account sees.

### What the MCP client keeps

The Console keeps MCP connections on the server, per person. Tokens, refresh tokens, PKCE verifiers, and client registrations never reach the browser, which gets only the account, server details, scopes, and token expiry. A ViteHub MCP connection keeps no credentials.

By default, connections live in server memory, and a restart ends them. To keep them, turn on the default [KV](/docs/kv) store with `kv: true` (or an explicit default KV configuration) and set `VITEHUB_CONSOLE_MCP_KEY`:

```ts
vitehub({
  preset: 'cloudflare',
  console: { auth: 'app', mcpClient: true },
  kv: true,
})
```

Generate the key with:

```sh
openssl rand -base64 32
```

With the key, the Console seals each connection and client registration with AES-GCM under `vitehub:console:mcp-client:`. Key names hold a hash of the owner, not their id or email. A sealed value opens only under its own key name with the same key, so a key change makes old connections read as missing. Connections survive restarts, and all instances read the same ones, so a sign-in can finish on another instance. Use a KV driver all instances share, such as Cloudflare KV. When two requests change one connection at once, the last write wins. When both refresh the token, you may need to sign in again.

> [!WARNING]
> Every MCP request starts on the server. A person with the `mcp-client` section can make the server send requests to any URL. Give the section only to people you trust with the server's network.

Agents and ViteHub MCP cannot use these connections. The `vitehub` CLI of `vite dev` uses them as the local developer.

Without the key, use the MCP client only in development or on one Node server. Hosts with many instances, such as Cloudflare Workers, have one memory per instance, so a sign-in that finishes on another instance fails.

## Develop against a fixture

Use `vitehub console dev` to get the same Agent Invocations (Agent runs) on every restart. It validates a versioned JSON fixture, then runs the command after `--` with an in-memory Console journal. It does not write `.vitehub/data/console.sqlite`.

```bash [Terminal]
pnpm vitehub console dev \
  --fixture test/fixtures/console.fixture.json \
  -- pnpm dev
```

Fixture paths start at the Vite project root. List records oldest first, so the session list shows newest first. A version 1 fixture holds complete `AgentInvocationRecord` values. `cursor` is optional, because fixture mode sets it from the array order.

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

The command exits with the child's exit status. A child stopped by a signal gives `128 + signal number`. Bad arguments, unreadable files, bad JSON, unsupported versions, duplicate invocation ids, and invalid records print a diagnostic to stderr and exit `1` before the development command starts. Fixture mode is for development only. A production build rejects the fixture environment before it writes server output.

Fixtures often contain prompts and model output. Use fake or cleaned records before you commit them.

## Protect the Console route

The Console registers its page and assets under `/_vitehub/**` and its RPC route under `/_vitehub/rpc/**`. Provider status uses `GET /api/_vitehub/console/status`. It serves the [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-your-app) as static files under `/_vitehub/.well-known/skills/`, so `npx skills add <app>/_vitehub` installs the skill of your `vite-hub` version. These files need no sign-in.

ViteHub sends `X-Robots-Tag: noindex, nofollow` on the Console route and a robots meta tag in the page. This keeps the Console out of search engines that respect it. It does not block access, so choose an access policy below.

### Use the app Auth

Reuse the app's server Auth Definition and access policy:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: true,
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    auth: true,
    console: true,
    preset: 'node',
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    auth: true,
    console: true,
    preset: 'node',
  })],
})
```
:::
::

Keep providers, database, and session options in `server/auth.ts`. Add access routes that decide who can use the Console:

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

The `role` field comes from Better Auth's `admin()` plugin. You can use any role, permission, or allowlist the app has. To make the first account admin on a fresh deploy, set `VITEHUB_ADMIN_EMAILS` (see [Give the first admin role](/docs/auth/configure#give-the-first-admin-role)). To keep users and sessions across restarts, use [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).

- No session returns `401`.
- After sign-in, the callback gets the request and the signed-in `user`.
- `false` returns `403` and offers **Switch account**.
- A custom `Response` sets the rejection or redirect.

App Auth gives a built-in page at `/_vitehub/sign-in`, with the social providers and, when `emailAndPassword` is on, an email and password form. When sign-up is open, **Create one** opens a sign-up form (`emailAndPassword.disableSignUp: true` hides it). After sign-in, the page returns to the requested Console page. Failed attempts show the form again. Expired sessions show **Sign in**. The account menu can sign out. You need no Console Auth Definition, client, or sign-in route.

Every Console route needs an authorization callback, including `GET /api/_vitehub/console/status` and, when on, `GET /api/_vitehub/console/usage`. The two wildcard routes above cover them. A missing policy stops the build with `VITE_HUB_B0006`. Missing app Auth stops it with `VITE_HUB_B0005`. `console: true` alone never lets every signed-in user in.

For per-section rules or a separate Console policy, use an authorization file:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts' },
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', authorize: './server/console-authorize.ts' },
      preset: 'node',
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', authorize: './server/console-authorize.ts' },
      preset: 'node',
    }),
  ],
})
```
:::
::

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => user?.role === 'admin')
```

A relative `authorize` path starts at the project root (the folder of `nuxt.config.ts` or `vite.config.ts`). In a Nuxt app, `./server/console-authorize.ts` sits next to the `app/` folder, not inside it.

The built-in page cannot complete two-factor challenges. For two-factor, passkeys, or a custom sign-in UI, use your own page:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', signInPage: '/sign-in' },
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', signInPage: '/sign-in' },
      preset: 'node',
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', signInPage: '/sign-in' },
      preset: 'node',
    }),
  ],
})
```
:::
::

The page gets `redirect`, such as `/sign-in?redirect=%2F_vitehub%2Fauth`. Go back there after sign-in, and accept only paths on your origin. Only a page visit (a `GET` that accepts `text/html`) goes to the page. Other signed-out requests to `/_vitehub/**`, such as a script `fetch`, get `401`. ViteHub adds the app's mount base. `auth: false` with an `authorize` that returns `401` also uses `signInPage`. Independent Console Auth has its own page and ignores this option.

### Use Console Auth

Console Auth has its own Better Auth session and does not need the app's Auth. On a Node host, the inline GitHub setup lets in only verified emails in `allowedEmails`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
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
  },
})
```
:::

:::tabs-item{label="Nitro"}
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
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
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
:::
::

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and [`VITEHUB_SECRET`](/docs/env/app-secret) on the server. Console Auth signs sessions with a secret derived from `VITEHUB_SECRET`. `BETTER_AUTH_SECRET` wins when set, and `secretEnv` names another required variable. Changing either secret signs out every Console session.

- `baseURL` is the public origin for OAuth redirects. Set it when a proxy ends TLS.
- The GitHub callback URL is `https://agent.example.com/api/_vitehub/console/auth/callback/github`. For Nuxt apps mounted below `/`, ViteHub adds `app.baseURL` to the callback and redirects.
- Put `databasePath` on persistent storage. Console Auth creates or updates its Better Auth tables before the first protected request, and refuses to run without a database or secret.

App and channel requests keep their own authentication. If Primary Auth (the app's Auth) protected the Console before, remove its `/_vitehub/**` and `/api/_vitehub/console/**` access routes. Keep `auth: true` if app routes still use it. Otherwise both guards apply and maintainers sign in twice.

Inline Console Auth uses `node:sqlite` and needs the Node preset. Other presets need a Console Auth Definition file with a database adapter the host supports.

For a custom provider, a GitHub organization check, or Better Auth server plugins, commit `vitehub/console/auth/server.ts` and use `console: { auth: {} }`:

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

ViteHub sets the auth route to `/api/_vitehub/console/auth/**` and the cookie prefix to `vitehub_console`. It guards `/_vitehub/**` and every method under `/api/_vitehub/console/**`, including RPC and invocation actions, but not the sign-in page and callback. A signed-out visit opens `/_vitehub/sign-in`, and the provider redirect starts when the user selects its button. Console APIs return 401 without a session. The server file must give a Better Auth database adapter on durable storage and a secret. ViteHub runs Better Auth migrations before the first protected request. Set `migrate: false` only when your own startup applies the schema.

An optional `vitehub/console/auth/client.ts` adds Better Auth client plugins and a `setup` hook, for the Console pages only. `setup` gets the client from `createAuthClient()`. Use `loadAuthClient(client)` from `vite-hub/auth/vue` for members that are not calls, such as `$store`:

```ts [vitehub/console/auth/client.ts]
import { defineConsoleAuthClient } from 'vite-hub/console/auth/client'

export default defineConsoleAuthClient({
  plugins: [],
  setup(client) {
    // Add Console-only browser behavior here.
  },
})
```

Use `console.auth.server` or `console.auth.client` for a file in another place. A relative path starts at the project root. An explicit path conflicts with a found file at the default place. Client code does not authorize requests.

On Cloudflare, use `console: { auth: { provider: 'cloudflare-access' } }` with a Cloudflare Access application. See [Cloudflare](/docs/frameworks-hosts/cloudflare).

### Use another authentication library

With another authentication library, set `auth: false` and give the Console an `authorize` function:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    agent: true,
    console: { auth: false, authorize: './server/console-authorize.ts' },
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: { auth: false, authorize: './server/console-authorize.ts' },
    preset: 'node',
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: { auth: false, authorize: './server/console-authorize.ts' },
    preset: 'node',
  })],
})
```
:::
::

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'
import { readHostSession } from './session'

export default defineConsoleAuthorize(async ({ request }) => {
  const session = await readHostSession(request)
  if (!session) return new Response('Sign in first.', { status: 401 })
  return session.user.role === 'admin'
})
```

`readHostSession()` stands for your own session code. With `auth: false`, `authorize` gets only the Web `Request`. Keep any host middleware you have as a first layer.

### Limit a user to some sections

`authorize` works with every `auth` choice. Every Console data route calls it with the Web `Request` before it reads data: RPC, invocation actions, Env management, Channel replay, Schedule runs, and Connections management. Page visits run the same check:

- No session: the sign-in page, or the signed-out state when there is none.
- Rejected: an **Access denied** page with status `403`.
- A `Response` from `authorize` goes out as it is. Return `new Response(null, { status: 404 })` to hide the Console.

The client script and static assets skip `authorize`, because they hold no project data. `authorize` returns one of these values:

| Result | Effect |
| --- | --- |
| `true` | Allows every Console section. |
| `{ sections: ['content'] }` | Allows only these section ids, with all their actions. An empty list returns `403`. |
| `{ sections: ['kv:read'] }` | Allows `kv` for reads only. `write` and `destructive` operations return `403`, unless the call only reads (`readOnlyWhen`). |
| `{ sections: ['blob:media'] }` | Allows Blob operations on the `media` store only. `'blob:media:read'` allows only reads. |
| `false` | Returns `403`. |
| A `Response` | Returns that response, for example a `401` or a redirect. |

Any other value returns `500`. With `auth: 'app'` and session-based Console Auth, the context also has the signed-in `user`:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => {
  if (user?.role === 'admin') return true
  if (user?.role === 'editor') return { sections: ['content'] }
  return false
})
```

A section entry is the section id, or `'<section>:read'` for read only. A read grant allows only `kind: 'read'` operations and calls that `readOnlyWhen` marks as reads, on every surface (Console RPC, `vitehub <namespace> --url`, agent tools, MCP). Write routes such as Env management, Schedule runs, Channel replay, Agent Invocations, and media upload refuse it. With `'kv:read'` and `'kv'` together, the full grant wins. The Console hides write actions, such as the KV editor and Blob upload, for a read grant.

#### Grant one Blob store

`'blob'` allows the Blob operations (`blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.del`, `blob.media`, and `blob.variants`) on every store. `'blob:<store>'` allows them on one store, and `'blob:<store>:read'` only the reads. A store grant gives editors and their MCP agents the public Media store without the private Content store:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => {
  if (user?.role === 'admin') return true
  // `media` is the served store. The `default` store keeps the Content workspace.
  if (user?.role === 'editor') return { sections: ['content', 'comments', 'blob:media'] }
  return false
})
```

The server checks the store of each call on every surface (Console RPC, `vitehub blob --url`, agent tools, MCP). A call without `store` uses `default`. A call to another store returns `403` (`CONSOLE_ACCESS_DENIED` over MCP), and the message names the needed grant, such as `'blob:default'`. `blob.list` returns only allowed stores in `stores`. A store grant does not open the Blob page, which needs `'blob'` or `'blob:read'`, so editors use the [Media library](/docs/content/console#media-library) of Content. A store named `read`, or with `:` in its name, needs the whole `'blob'` grant.

::warning
Breaking change: a section grant now includes its write actions. `{ sections: ['kv'] }` lets a user set and delete keys, `'blob'` lets them upload and delete blobs, and `'rate-limits'` lets them reset counters. Before, these pages only read. For a read-only role, use `'<section>:read'`, such as `{ sections: ['kv:read', 'blob:read'] }`.
::

Section ids are the ids in the Console URL, such as `env`, `connections`, `agents`, `usage`, `content`, `blob`, `databases`, `kv`, `workspaces`, `workflows`, `queues`, and `schedules`. Each route and RPC operation declares its section, and the server returns `403` for a section outside the list. Write actions need the section that owns them:

- Env management: `env`. Connections management: `connections`.
- Agent Invocations and Channel replay: `agents`. Schedule runs: `schedules`.
- Workflow starts, cancels, and resumes: `workflows`.
- Content saves and publishes: `content`. Content then checks `content.can()`, so `defineContent({ authorize })` decides which collections and actions an editor gets.

The navigation shows only allowed sections, but the server check is the security boundary.

### How each mode checks a request

Each Console data route checks access itself. The Console Auth middleware stays as a first layer in front.

| Configuration | Check in each Console data route |
| --- | --- |
| `auth: false` | Allows the request. A production build and server log a warning. |
| `auth: 'app'` | Checks the Primary Auth Session and every Auth access route that protects the Console. Returns `401` or `403`. |
| `auth: { ... }` | Checks the Console Auth Session and its `authorize` callback with `withAuthorization()`. Returns `401` or `403`, without a sign-in redirect. |
| `auth: { provider: 'cloudflare-access' }` | Verifies the Cloudflare Access token. Development has no Access edge, so the development server allows the request. |
| `authorize` | Runs after any check above. It can reject the request or limit it to some sections. |

All Console paths here sit under the application base: an explicit ViteHub application base (set from Nuxt `app.baseURL`), else a root-relative Vite `base`.

- With `base: '/portal/'`, host middleware must protect `/portal/_vitehub/**` and `/portal/api/_vitehub/console/**` for every method, including assets, RPC, and invocation actions. Update host policies when you change the base or upgrade to base-aware routes.
- Absolute and protocol-relative bases, such as `https://cdn.example/portal/` and `//cdn.example/portal/`, are asset CDN URLs. Without an explicit application base, protect `/_vitehub/**` and `/api/_vitehub/console/**` at root. Relative bases (`''` or `'./'`) also use root routes.
- When Nitro `baseURL` matches the application base, Nitro adds it once, so the Console is at `/portal/_vitehub`.
- Primary Auth access routes must use the application base too. Built-in Console Auth adds it for you.

### Open the Console from the app's pages

The ViteHub tools pill shows at the bottom of the app's pages for people the Console lets in. Its **Console** button opens the Console in a floating window, next to page tools such as [Comments](/docs/comments/configure#turn-comment-mode-on-and-off).

With `auth: 'app'`, sign in and open any page to see the pill. It also shows after you open the Console, or on a page with the `?vitehub` query.

The pill uses the Console access check, for any section. People the Console rejects do not get it. An `authorize` result with at least one section, such as `{ sections: ['content'] }`, allows it. With the development default, the pill exists on the development server only.

- **Turn off ViteHub tools** (the **×**) hides the pill until you open the Console, use `?vitehub`, or sign in again. You can drag the small mark it leaves: the pill opens where you drop it.
- The ViteHub mark collapses the pill to a small hexagon 2px from the screen edge. It stays collapsed on the next pages until you select the mark. Open windows and comment mode stay as they are.
- Drag the mark to dock the pill on another edge, where you release it. On the left and right edges, the mark and **×** share the first row and the tools stack below. Windows open from the docked edge. The browser remembers the place.

#### Keep the pill off your own toolbar

A page with its own bar where the pill docks, such as a review toolbar at the bottom center, can move the pill aside. Set `data-vitehub-pill="mark"` on `<html>`. The pill folds to the ViteHub mark and moves to the nearer end of the bottom edge. Remove the attribute and the pill comes back as it was. In Nuxt, set it from the page or component that draws the bar:

```ts
useHead({ htmlAttrs: { 'data-vitehub-pill': 'mark' } })
```

The attribute is in the server-rendered page and follows client-side navigation, so the pill never covers the bar, even on first paint. Pressing the mark opens the pill until the page removes the attribute. The attribute does not change the collapsed state on other pages or the dock edge. On other edges the mark folds in place, because pages keep their back button and menus at the ends of the top edge.

Every HTML page of the app has a short inline script, the page tools bootstrap. It is in server-rendered and prerendered pages, so it works when a host serves static files, such as Cloudflare Workers static assets. It reads the URL and two cookies, and loads the page tools loader only when it finds one of these hints:

| Hint | Set by |
| --- | --- |
| `?vitehub` in the URL | You. `?vitehub=console` also opens the Console window. |
| `vitehub-tools=1` | `GET /_vitehub/page/session`, when a page tool allows you. |
| `vitehub_session=1` and no `vitehub-tools` cookie | [App Auth](/docs/auth/configure#session-marker-cookie). It sets the marker on sign-in and clears `vitehub-tools`, so the next page asks the session route again. |

Visitors without a hint get no request and no extra script. The loader calls `GET /_vitehub/page/session`, which runs the access check and sets `vitehub-tools=1` or `vitehub-tools=0`, so a signed-in person without access makes one request per session. Sign-out clears the cookie. The Console serves that route and the loader, so the pill works without Comments. The cookies hold no secret and are not `HttpOnly`, because the bootstrap reads them. Every Console route still checks access.

The bootstrap is an inline module script. When the page's Content Security Policy has a script nonce, the server gives it that nonce. A policy without nonces that blocks inline scripts also blocks the bootstrap on prerendered pages. Allow its hash, or use `?vitehub` on a server-rendered page, where the server adds the external loader instead.

### Start Agent Invocations

`invoke` lets the Console start Agent Invocations and run manual Schedules. It is `true` on the development server and `false` in a production build by default:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts', invoke: true },
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', authorize: './server/console-authorize.ts', invoke: true },
      preset: 'node',
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', authorize: './server/console-authorize.ts', invoke: true },
      preset: 'node',
    }),
  ],
})
```
:::
::

The invocation routes call your access policy, so it decides who can start invocations. A user also needs the `agents` section. `invoke: false` keeps inspection and turns off new invocations. Fixture mode always turns them off.

### Impersonate users

`impersonation` lets a Console administrator open the app as one of its users. It is off by default:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts', impersonation: true },
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', authorize: './server/console-authorize.ts', impersonation: true },
      preset: 'node',
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      auth: true,
      console: { auth: 'app', authorize: './server/console-authorize.ts', impersonation: true },
      preset: 'node',
    }),
  ],
})
```
:::
::

It needs app Auth with Better Auth's [admin plugin](https://www.better-auth.com/docs/plugins/admin) and the [Auth event log](/docs/auth/events), which records each start and stop. Without app Auth, the build stops with `VITE_HUB_B0005`.

```ts [server/auth.ts]
import { createDatabaseAuthEventStore, defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { useDatabase } from 'vite-hub/database/drizzle'
import { admin } from 'better-auth/plugins'

export default defineAuth(() => ({
  database: authDatabase('auth'),
  plugins: [admin()],
  events: { store: createDatabaseAuthEventStore({ db: useDatabase('auth').db }) },
}))
```

Open **Auth › Users**, select a user, and select **Impersonate**. The app opens, signed in as that user. To stop, open the Console and select **Stop impersonating**. Better Auth restores your session.

You can impersonate when both are true:

- The Console access policy gives the `auth` section. A read-only grant (`'auth:read'`) cannot impersonate.
- The app session has Better Auth's `user: ['impersonate']` permission, from the admin plugin's `adminRoles` and `adminUserIds`.

Better Auth refuses banned users and other administrators. To allow administrators, set `admin({ allowImpersonatingAdmins: true })` or give the `impersonate-admins` permission. The user panel shows why Better Auth refuses a user.

The security model:

| Rule | What it means |
| --- | --- |
| Off by default | Without `console.impersonation`, there is no Impersonate action, and the Auth route answers `404` to start and stop. Better Auth's own admin endpoints stay as the app sets them. |
| Short session | The session lasts `admin({ impersonationSessionDuration })` seconds, one hour by default. It never refreshes past that, also when a client sends only the session cookie. |
| Recorded | Auth Activity shows `impersonation.started` and `impersonation.stopped`, with you as the actor. Without `events.store`, the action is off. When the log cannot record a start, the impersonation does not start. |
| No new credentials | An impersonation session cannot approve OAuth, MCP, or device clients, create API keys, register passkeys, set or change the password, change the email, phone number, or username, link or unlink accounts, read or refresh a linked account's provider tokens, change two-factor settings, create one-time tokens, or start another impersonation. These return `403` with `IMPERSONATION_FORBIDDEN`. |
| Not in the Console | With app Auth, an impersonation session never opens the Console. Each Console page shows **Viewing the app as …** with **Stop impersonating**, and data routes return `403` with `CONSOLE_IMPERSONATING`. With Console Auth or Cloudflare Access, the Console keeps its own session, and the Auth section shows a **Stop impersonating** banner. |
| Same origin | Start and stop use the Auth route, which needs the same origin and `x-vitehub-console: 1`. The **Viewing the app as …** page calls Better Auth's `stop-impersonating` endpoint, which checks the origin. |

When the session ends before you stop it, sign in again, because Better Auth cannot restore yours.

App code can detect impersonation. On the server, `session.impersonatedBy` is the administrator's id:

```ts [server/api/me.get.ts]
import { withAuth } from 'vite-hub/auth/server'

export default withAuth((_event, { session, user }) => ({
  id: user.id,
  impersonatedBy: session.impersonatedBy ?? null,
}))
```

In Vue, `useUserSession()` gives `impersonatedBy` and `stopImpersonating()` for your own banner:

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

On the development server, Console users can connect [Connections](/docs/connections), set API keys, refresh tokens, and disconnect. A production build has the Connections section and its routes only with `connections: { management: true }`:

```ts
vitehub({
  connections: { management: true },
  console: { auth: 'app', authorize: './server/console-authorize.ts' },
  database: true,
  preset: 'node',
})
```

> [!WARNING]
> Every user with the `connections` section can then manage every Connection. Limit the policy to the people who own the provider accounts.

In `vite dev`, a Console without sign-in (`local` access, or `console: { auth: false }`) answers only loopback requests. A `Host` other than `localhost`, `127.0.0.1`, or `[::1]`, or a peer address that is not loopback, gets `403` with `CONSOLE_LOOPBACK_ONLY`. This does not apply to production servers, so set `console.auth` or `console.authorize` for them.

Console RPC requests must come from the same origin. The route rejects opaque origins and browser requests marked `same-site` or `cross-site`. Browser Fetch Metadata lets same-origin requests through reverse proxies. Without it, the route compares the `Origin` header with the request URL. For older browsers that send `Origin` without Fetch Metadata, hosts must rebuild the public request origin.

Browsers can omit both headers on HTTP origins. Then the request must send `x-vitehub-console: 1`. A foreign page cannot add this header without a CORS preflight, which the route rejects. The built-in client adds it. Server clients must add it when they send no origin headers. The marker is not a credential: authentication and authorization still apply.

The `agents.invoke` operation takes an Agent name and the fields of `ConsoleAgentInvocationInput` from `vite-hub/console`: a non-empty `prompt`, and optionally a configured `invokerProfileId` and earlier `messages`.

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

History must hold valid ViteHub Messages with `user` or `assistant` roles, unique IDs, and `text`, `file`, `image`, or `audio` parts. The Console keeps message metadata and adds the prompt as a user Message. It rejects bad Messages, `system` or `tool` roles, and other parts (including nested tool calls, tool results, and approvals) before the Agent starts. Omit `messages` for a prompt-only invocation. Each request creates a new invocation and does not resume an earlier runtime session.


### Cancel a running session

A pending or running session shows **Cancel session** in its header when the Console has `invoke` access for its Agent. Without it, the button is hidden and `invocations.cancel` returns 403.

The Console calls `invocations.cancel(id)` on the Agent's journal. A run in the same process stops at once. A run in another process sees the request at its next claim renewal, within 10 seconds. When the Driver (the code that runs the Agent) cannot stop the run, the header shows `Cancel requested, not enforced by <driver>`, and the session runs until the Driver returns. See [Cancel an invocation](/docs/agents/invocations#cancel-an-invocation) for each Driver.

A finished session shows **Abort stale execution**. It sends an abort signal to any execution still registered in the Console process, without changing the journal. The result says whether a local execution got the signal and names any Driver that cannot abort. A journal that did not keep a pending or running request returns 503.

Nuxt needs no SEO module for the `X-Robots-Tag` default. If the app uses `@nuxtjs/robots` or `@nuxtjs/seo`, add route rules so its robots and sitemap modules skip Console pages:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  routeRules: {
    '/_vitehub': { robots: false },
    '/_vitehub/**': { robots: false },
  },
})
```

Do not use `robots.txt` as access control. Crawlers can ignore it, and a blocked URL can still be listed.

Read [Auth](/docs/auth/server-api#authorize-access-routes) for sign-in redirects and the full callback contract.

## Know what the Console stores

When Agents are on and no journal (the store of run records) is set, the Console adds a fallback journal at `.vitehub/data/console.sqlite`. It keeps invocation records and searchable text: prompts, messages, final text, progress updates, and session titles. A KV-only Console adds no Agent journal or Agent read endpoints.

Console image uploads use the configured Blob store. Before each new upload, the Console retries at most 100 pending rollback records. Malformed batch records move unchanged to `_vitehub/console/quarantine/batch/<id>`. New uploads continue, but stored attachment references stay unavailable while any quarantine record exists, because their delete owner is unknown. Quarantine deletes no image bytes.

To repair a quarantined record:

1. Get its original attachment UUIDs from trusted storage history.
2. Write their JSON array (1–10 UUIDs) to `_vitehub/console/cleanup/batch/<id>` for new quarantines, or `vitehub-console-attachment-cleanup/<id>` for legacy ones.
3. After a later upload drains that cleanup record, delete the quarantine object through the Blob provider.

If you cannot get the original UUIDs, keep the quarantine record. Guessing can delete kept images.

Set `observations` when the fallback journal needs larger records or more time to flush pending writes:

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

These limits apply only to the fallback journal. For a shared journal from Agent Definitions or `agent.invocations`, set that journal's `observations` instead. See [Agent Invocations](/docs/agents/invocations) for defaults and bounds. Larger limits use more storage and memory.

Set `VITEHUB_CONSOLE_DATABASE_URL` to put the journal on another volume or libSQL endpoint. Relative `file:` paths start at the project root:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=file:/var/lib/my-app/console.sqlite
```

Authenticated libSQL endpoints also need `VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN`:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=libsql://my-database.turso.io
VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN=secret-token
```

The fallback journal keeps every finished record by default. Set `retention` to remove old finished records by age, count, or size. All set limits apply together, oldest records first:

```ts
console: {
  auth: 'app',
  authorize: './server/console-authorize.ts',
  retention: { maxAge: '14d', maxSize: '30%' },
}
```

`retention` options:

- `maxAge`: a duration such as `'14d'`, or milliseconds.
- `maxRecords`: a positive integer.
- `maxSize`: a size such as `'500MB'`, bytes, or a percent of the volume that holds the journal file, such as `'30%'`. A percent counts only the journal file. `maxSize` limits the live data of the whole database file, so keep the journal in its own file. A file created before this release keeps its largest size until a `VACUUM` rebuilds it, but new records reuse its free pages.

An invalid limit fails the build with `VITE_HUB_B0015`. The D1 fallback does not support `maxSize`, because D1 reports the size of the whole app database. It fails the build with `VITE_HUB_B0016`. See [Agent Invocations](/docs/agents/invocation-storage#use-a-custom-store) for how each limit runs.

> [!WARNING]
> In production, you must still decide how long to keep records that can hold sensitive data.

Workflow, Queue, and Schedule inspection do not use the journal. Workflow and Queue show no run or message history, because ViteHub has no provider-independent way to list it yet. The Schedule page lists Schedule Definitions. Definitions with `manual: true` show a run action when Console invocation is on. Use [`vitehub schedule`](/docs/development/cli#run-and-inspect-schedules) to run them or list runs, in development or on a deployment with `--url`.

The fallback applies only when no journal is set:

- A journal from `defineAgent({ invocations })` or the app-wide `agent.invocations` wins. The Console reads it, and copies nothing into `console.sqlite`.
- An Agent with `invocations: false` records no sessions.
- The fallback needs `defineAgent` from `vite-hub/agent`. Definitions imported from `@vite-hub/agent` must set their own `invocations` store.
- With more than one Agent, all must use the same journal. Set [`agent.invocations`](/docs/agents/invocation-storage#use-one-journal-for-every-agent) to give them one. Different journals fail at runtime setup, because the Console has one combined query interface.

The SQLite fallback fits development and Node deployments with durable local storage. It belongs to one replica and is lost when the replica is replaced, unless the host keeps that path. On Cloudflare, Netlify, Vercel, and Deno production, set a durable hosted journal.

Every read goes through the RPC route at `/_vitehub/rpc/**`. Listings and metadata use `GET` semantics. A KV value read uses a JSON-body `POST`, so the key stays out of the URL. KV writes use the same route with an `action` (`set`, `del`), and Blob writes with `put` and `del`, which run `kv.set`, `kv.del`, `blob.put`, and `blob.del`. Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

KV inspection calls the store's paginated `list`, `get`, and `has`, never `set`, `del`, or `clear`. Each key page has at most 200 entries. Loading more passes the provider's cursor. Values show as text or formatted JSON, cut at 256 KiB. Listing and reading can still count as provider operations.

Blob inspection calls only the store's `list`, with an optional pathname prefix. It returns at most 100 objects first and 250 per request. It follows provider cursors past hidden ViteHub objects (up to ten provider pages per request), and **Load more** follows the returned cursor. ViteHub keeps its own objects, such as Workspace history and Console attachments, under `_vitehub/` and hides them, so a page can have fewer objects than its limit. **Show ViteHub files** lists them. Blob inspection never calls `get`, `head`, `serve`, `sign`, `put`, or `del`, and object contents and provider URLs never reach the Console. Listing can still cost provider requests.

## Inspect the Agent context

Open an Agent Invocation and expand **Captured setup** to see that run's context: the final instruction blocks and the tools the model sees, with each tool's description and input and output JSON Schemas. It is the result after the Agent Definition, Capabilities (features you add to an Agent), and runtime tools apply, so it covers dynamic tools too.

Invocation journals keep metadata only by default. Then Captured setup has tool names but no instructions, descriptions, or schemas. Set `configuration: 'content'` on the Agent's journal to keep the context apart from other trace content. `content: 'content'` also keeps it. Large observations stay inside ViteHub's trace limits and are marked when cut.

> [!WARNING]
> This context can contain secrets or customer data from app code. Protect it like prompts and model output, with the same access, retention, and encryption controls. See [Agent Invocations](/docs/agents/invocation-storage#store-invocation-history).

## Inspect Skills

Open **Skills** to browse the files bundled with each Agent Definition: colocated `skills/` files and Skills added with `agentWithSkills()`. Select a file to read its Markdown preview or source. Links to other bundled files open them in the tree. The URL keeps the selected Agent and file.

**Skill index** opens [ViteHub's published Skill index](https://vitehub.dev/.well-known/skills/index.json), which is not your app's Skills.

This view reads the current Agent Definition. It does not start an invocation or refresh a Source. See Source-mounted Skills in a session's Workspace. Text previews stop at 512 KiB. Binary files are listed without a preview.

## Inspect usage

Open **Usage** to see the tokens and cost that providers report for the past 24 hours, 7 days, 30 days, or 90 days. It groups completed Agent Invocations by time and model. A warning shows when the scan reaches 10,000 records or a finish event is cut, so partial totals never look complete.

Session details show the usage record of one invocation. Add the [Usage Capability](/docs/agents/capabilities/usage) when the provider needs an explicit usage request, estimated cost, or a typed Agent Usage Record at finish. Providers that report usage without it still show, because the recorded finish event is the source of truth.

The Console does not fill in missing provider data. Token counts, model metadata, and cost stay empty when the provider does not report them. Model breakdowns sort by total tokens, highest first, then by model name.

## Fix common failures

| Symptom | Check |
| --- | --- |
| `/_vitehub` returns `404` | Set `console` with an `auth` choice, then restart the development server. A missing or `false` option registers no route. |
| Agents is missing from the home | Set `agent`. The home lists only primitives on in the same ViteHub configuration. |
| KV is missing from the home | Set `kv`. |
| A KV key page stops at 200 entries | Load the next page or filter by key prefix. Values load only when you select a key. |
| Blob is missing from the home | Set `blob` with a preset that supports Blob, or an explicit Blob store. |
| Blob inspection returns a provider error | Give the deployed Console permission and credentials to list the store. |
| Databases is missing from the home | Set `database`. |
| Rate Limits is missing from the home | Set `rateLimit` and use statically declared `requireRateLimit()` policies. |
| Workspaces is missing from the home | Set `workspace` and add a Workspace Definition. |
| Sandbox Tasks (Sandboxes) is missing from the home | Set `sandboxTask: true` with a preset that supports Sandbox Tasks. |
| KV inspection returns a provider error | Give the deployed Console permission and credentials to read the store. Read-only requests still read from the provider. |
| Agents opens but has no sessions | Invoke an Agent. Check that it uses the fallback journal, not a separate `invocations` store. |
| A production build fails with `VITE_HUB_B0014` | Set `console.authorize` to a server file that default-exports `defineConsoleAuthorize()`. |
| `console: true` reports missing app Auth or Console access policy | Set `auth: true` and allow the Console routes in the app Auth Definition. Use `console: { auth: false }` only when you want no sign-in. |
| ViteHub says `console.auth` is required (`VITE_HUB_B0004`) | Add `auth` to the `console` object: `false`, `'app'`, or a Console Auth config. |
| `auth: 'app'` fails with `VITE_HUB_B0005` | Set `auth: true` and add an Auth Definition, such as `server/auth.ts`. |
| `auth: 'app'` fails with `VITE_HUB_B0006` | Set `console.authorize`, or add Auth access routes with an `authorize` callback for the routes in the message. |
| The build or server warns that `auth: false` has no sign-in | Add `console.authorize`, or set `console.auth` to `'app'` or a Console Auth config. |
| Console data routes return `500` with "console.authorize must return" | Return `true`, `false`, a `Response`, or `{ sections: string[] }` from `authorize`. Use the global `Response`. A Response-like object, or a Response from another Fetch implementation, is invalid. |
| Agent Console startup fails on a hosted preset | Set `agent.invocations: 'database'`, or give every Agent Definition one durable journal. The SQLite fallback needs a writable, persistent filesystem. |
| The page returns `401` | Sign in through the host's Auth provider. |
| The page returns `403` with **Access denied** | `authorize` or the `auth` check rejected this account. Check the callback and the user's role or permission. |
| A section is missing or returns `403` | `console.authorize` returned `{ sections }` without that section id. |

### Console error codes

Each failed Console request returns JSON with a stable `code`, a `message` that says why, a `fix`, and a `docs` link. RPC failures also keep `ok: false` and `status`. The Console shows one next step: sign in again, reload, try again, or read the docs. It offers a retry only when a retry can work.

| Code | Status | Fix |
| --- | --- | --- |
| `CONSOLE_SIGN_IN_REQUIRED` | `401` | Sign in again. |
| `CONSOLE_ACCESS_DENIED` | `403` | Sign in with an account that the access policy allows. |
| `CONSOLE_MANAGER_REQUIRED` | `403` | The session has no user id, so a management action cannot name its manager. The Auth Definition that protects the Console must return a user with an id. |
| `CONSOLE_IMPERSONATING` | `403` | This browser uses an impersonation session. Stop impersonating to get your session back. |
| `CONSOLE_DEVELOPMENT_ONLY` | `403` | Rebuild and deploy with an explicit `console.auth`: `console: { auth: 'app' }` with the Primary Auth Definition, or a Console Auth session. Set `console.authorize` to limit who may use it. |
| `CONSOLE_ORIGIN_REJECTED` | `403` | Open the Console from its own URL. Proxies must forward the public `Host` and `Origin` headers. |
| `CONSOLE_ACCESS_NOT_CONFIGURED` | `500` | Build the app with the ViteHub plugin. |
| `CONSOLE_AUTHORIZE_REQUIRED` | `500` | Set `console.authorize`. |
| `CONSOLE_AUTH_NOT_CONFIGURED` | `500` | Add an Auth Definition, or configure Cloudflare Access. |
| `CONSOLE_MCP_ORIGIN_REQUIRED` | `503` | Set `vitehub({ publicUrl })` or `console.mcp.resource`, so [MCP OAuth](/docs/development/mcp#set-up-oauth) has an origin a request cannot change. |
| `CONSOLE_MCP_OAUTH_INCOMPLETE` | `503` | Add `jwt()` and `oauthProvider({ resources, scopes })` to the Auth, as in [Set up OAuth](/docs/development/mcp#set-up-oauth). |
| `CONSOLE_CONNECTIONS_MANAGEMENT_UNAVAILABLE` | `404` | Set `connections: { management: true }` for production. |
| `CONSOLE_ENV_MANAGEMENT_UNAVAILABLE` | `404` | Give the Env declaration a management bridge. |
| `CONSOLE_REQUEST_INVALID` | `400`, `405`, `413` | Reload the Console. Deploy the Console and the server from the same build. |
| `CONSOLE_NOT_FOUND` | `404` | Reload the Console. |
| `CONSOLE_CONFLICT` | `409` | Reload, then try again. |
| `CONSOLE_UNAVAILABLE` | `408`, `429`, `502`–`504` | Wait, then try again. |
| `CONSOLE_REQUEST_FAILED` | `500` | Try again, then read the server logs. |
| `CONSOLE_MCP_UNREACHABLE` | `502` | Check that the MCP server runs and that the URL is its Streamable HTTP endpoint, such as `/mcp`. |
| `CONSOLE_MCP_SIGNED_OUT` | `409` | Sign in again. For a token, connect again with a new one. |
| `CONSOLE_MCP_AUTHORIZATION_FAILED` | `400`, `404`, `409`, `502` | Start the sign-in again. The server must publish RFC 9728 metadata that names an authorization server with client registration. |
| `CONSOLE_MCP_KEY_INVALID` | `500` | Set `VITEHUB_CONSOLE_MCP_KEY` to 32 random bytes as base64 or hex, such as the output of `openssl rand -base64 32`. |
| `CONSOLE_MCP_KV_REQUIRED` | `500` | Turn on the default KV store with `kv: true` or an explicit default KV configuration, then rebuild. |

A route that fails with its own diagnostic keeps that code, such as `VITE_HUB_R0065`. Connections and Env management routes keep their `CONNECTION_*` and `ENV_BRIDGE_*` codes and add `fix` and `docs`.

See [Agent Invocations](/docs/agents/invocations) for custom stores and the invocation lifecycle. To build your own inspection page instead of the full Console, use [UI parts](/docs/ui) such as [Trace](/docs/ui/trace) and [Code block](/docs/ui/code-block).

### Image upload boundaries

Image uploads need `console.invoke`. The Agent and invoker profile you chose at submit stay fixed while images upload. If you switch Agents, the pending request stays with the first Agent.

- Images must be PNG, JPEG, WebP, or GIF: at most ten images and 10 MiB in total per invocation.
- Blob storage must return an HTTP or relative serving URL.
- If storage or setup fails before the Agent takes the images, the Console rolls back the uploads.
- Images given to an Agent stay under `_vitehub/console/attachments/` and follow your Blob retention policy.

## Inspect capabilities

Open the right panel's tab chooser and select **Capabilities**. Select a Capability to see its recorded data and tools. MCP groups tools by server with their original names and schemas. Title shows its settings, progress, and result. Other Capabilities get a default tools and configuration view.

The panel reads the Invocation's snapshots. It does not run MCP discovery or title generation. Missing or cut data is marked. You can [add a read-only view](/docs/agents/capabilities/custom#contribute-an-inspection-view) with the shared JSON Render component catalog.

## Work from a page

After you open the Console, go back to any app page. The ViteHub pill stays while its hint cookie is set, or when you open a page with `?vitehub`. The server checks each tool's access, because the cookie grants nothing. Signed-out visitors do not get the editor.

Choose **Console** to open it in a floating window. **Content** shows only when Content is installed and you have the full `content` grant. With `content:read`, use Content through **Console**. Choose **Select field**, then a page element marked with `contentField()`, to open that document in the Content editor.

- While you select, an open Content window moves aside. <kbd>Esc</kbd>, a second **Select field**, or a click outside a field cancels and brings it back.
- A click while you select never follows a link.
- A minimized window stays minimized until you pick a field.
- You can browse collections with the keyboard in the Content window. Content's read, write, and publish policies still apply.

When the page belongs to a document with an unpublished saved draft, the Content segment shows **View draft**. The pill finds the document from the collection `url` patterns, and shows the button only for documents you may read. **View draft** loads the page with that draft through a [preview frame](/docs/content/preview#preview-frames) form in this tab. Only this document shows as a draft, only your browser sees it, and the token stays in the form body.

On the draft page, a **Draft** tab sits on the pill, on the side facing the page, and the page has no banner. The tab marks text blocks that differ from the live page, such as headings, paragraphs, and list items. **N changes** turns the marks off and on. The pill compares the text of each block with the live page in a hidden frame, so a moved paragraph is not a change. Images, links, and styles are not compared. Removed blocks are counted. The tab hides while the pill is collapsed. **Back to live** shows the page as guests see it. Client-side navigation shows the next page live and checks it for a draft. The draft view shows the saved draft, not unsaved text.

Expanding or minimizing the window keeps the document and unsaved text.

- **Open in new tab** in the title bar opens the window's page in a full tab, with the same section, record, and filters. A middle-click or <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-click opens it in the background. **Copy link** copies it. The window stays open with its unsaved text.
- On a phone, the editor fills the screen.
- Client-side navigation keeps the editor open on its document. A full reload loses unsaved text, so the editor asks before you leave.
- The browser remembers the window size and editor route. The pill stores no document values.

The editor loads on first use. In production it uses a same-origin iframe and needs an accepted Console session. A normal Console page still refuses framing. `?embed=1` allows same-origin framing only after the access check. Your Content Security Policy must allow the same-origin frame.

Comments uses the same window for the page's threads and replies, without **Open in new tab**. When the Content editing tool is available, the Comments **Edit** action opens the document editor. Otherwise, plain-text field editing stays available as the Comments and Content policies allow.

## Inspect logs

[Logs](/docs/logs) uses Evlog for request capture, structured fields, redaction, sampling, and drains. Explorer and Stream show the selected event in the right inspector. The CLI reads the same source with `pnpm vitehub logs list --level error --json`.

[Get started](/docs/logs/get-started) with a temporary development buffer, or [connect an existing backend](/docs/logs/configure#read-an-existing-backend) for production. Follow polls the newest page every two seconds and can miss events. See [limits and errors](/docs/logs/limits-and-errors) for retention and inspection limits.
