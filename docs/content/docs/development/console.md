---
title: Console
description: Enable the Console, inspect configured primitives, and protect its routes.
navigation.order: 32
navigation.group: Local tools
icon: i-lucide-monitor-dot
---

The ViteHub Console is a page in your app that shows the primitives you turned on. It is off by default. Enable it, start the app, and open `/_vitehub`. To open deployed apps from one place, use the [hosted Console](#hosted-console) at [console.vitehub.dev](https://console.vitehub.dev).

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

## Section pages and URLs

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

## Page state in the URL

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

## Search

<kbd>⌘</kbd> <kbd>K</kbd> or <kbd>/</kbd> opens search from any Console page.

| Group | Items |
| --- | --- |
| Content | Drafts of every collection you may read, matched by title, id, fields, and body. An empty query shows recent changes. |
| Actions | Commands of the current page, **New** for each collection you may edit, **Publish all changes** when you may publish, and theme commands. |
| Go to | The Overview, each section, its pages, and its collections. |

Items also match aliases, such as `images` for Media and `deploy` for **Publish all changes**. <kbd>Enter</kbd> opens the highlighted item. <kbd>⌘</kbd> <kbd>Enter</kbd> opens it in a new tab. **Publish all changes** lists the changes it will publish. Choose **Publish N changes** to publish exactly those drafts, or press <kbd>Backspace</kbd> on an empty query to go back.

## Update ready

Each Console build has an id, which changes only when the Console catalog or client changes. An open Console compares its id with the deployed one once a minute and when the tab becomes visible. When they differ, choose **Update ready** at the bottom of the rail to reload. The sections response returns the deployed id as `build`.

## Enable the Console

The Console app is its own package, `@vite-hub/console-client`, so an app without the Console does not install it. Add it before you turn the Console on:

```bash [commands/install-console]
pnpm add @vite-hub/console-client
```

`vitehub add console` adds it for you. If it is missing, the build stops and prints the same install command.

Set `console` in the root ViteHub integration. Every environment must choose who can open the Console with `console.auth`:

| `auth` | Who can open the Console |
| --- | --- |
| `false` | Anyone who can reach `/_vitehub`. Use it on your own machine, or behind a host that already checks every request. |
| `'app'` | Users with a session from the app [Auth](/docs/auth). |
| `'token'` | Callers that send a token as `Authorization: Bearer` whose SHA-256 is in `VITEHUB_CONSOLE_TOKEN_SHA256`, such as the CLI or a Console on another origin. See [Use a Console token](#use-a-console-token). |
| `{ ... }` | Users of a separate Console Auth: inline GitHub sign-in, a Console Auth server file, or Cloudflare Access. |

The Console does not turn on [Comments](/docs/comments). Add `server/comments.ts` or set `comments: true` to get the **Comments** section. Comments turns on the Database when `database` is unset. Create its tables once with `vitehub database generate` and `vitehub database migrate`. With `database: false`, Comments fails the build: `VITE_HUB_B0018` for the `comments` option, `COMMENTS_B0001` for a `server/comments.ts` file.

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

A standalone Nitro 3 app adds Nitro after ViteHub. The Console app and its UI dependencies are prebuilt inside `@vite-hub/console-client`.

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

## Read the project

The `project.get` operation tells a client what the project runs and what the caller may use. Each section and each operation is one that the app installs and that [`authorize`](#limit-a-user-to-some-sections) allows for the caller. A read-only grant, such as `"kv:read"`, and an MCP access token without `vitehub:write` leave out the operations that change state. It does not need Agents or a section grant, so every caller that passes Console access can read it.

```bash [Terminal]
pnpm vitehub project info
pnpm vitehub project info --url https://app.example.com
```

```json
{
  "protocol": 1,
  "name": "my-app",
  "vitehub": "0.1.0",
  "sections": ["env", "kv"],
  "operations": ["definitions.list", "documents.action", "env.get", "kv.del", "kv.get", "kv.has", "kv.list", "kv.set", "media.action", "project.get", "sections.list"]
}
```

`protocol` is the version of this answer. A client stops when the protocol is one that it does not know. `vitehub` is the version of the `vite-hub` package that the app runs. Registered operations can appear even when their section has no Console page, such as `task.list`. An operation that reads its section from the input, such as `documents.action`, is in the list, and each call checks its section again.

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
import { vitehub } from 'vite-hub'

vitehub({
  console: { auth: "app", mcpClient: true },
})
```

The section uses the MCP SDK. Install it in your app first:

```sh
pnpm add @modelcontextprotocol/sdk
```

This section is the client side. [ViteHub MCP](/docs/development/mcp) is the server side: the MCP server that the Console itself serves at `/_vitehub/mcp`, which needs no option.

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
import { vitehub } from 'vite-hub'

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

## Use one Console for many projects

One Console build can open many ViteHub apps. Each app is a **project**. The Console that an app serves at `/_vitehub` opens that app. A Console that runs on its own origin, such as a copy on a static host, keeps a list of projects and switches between them.

Each project uses [`auth: "token"`](#use-a-console-token), or [`auth: "app"`](#use-the-app-auth) with [OAuth sign-in](#link-a-project-that-signs-in-with-the-app), and lists the origin of the Console in [`console.origins`](#call-the-console-from-another-origin):

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: {
      auth: 'token',
      origins: ['https://console.example.com'],
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    console: {
      auth: 'token',
      origins: ['https://console.example.com'],
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    console: {
      auth: 'token',
      origins: ['https://console.example.com'],
    },
  })],
})
```
:::
::

### Hosted Console

[console.vitehub.dev](https://console.vitehub.dev) is the same Console build as a static site. It has no server and keeps no state. The project list and the tokens stay in your browser, and the browser calls each project directly. ViteHub never receives your tokens or your project data.

To open a deployed app there:

1. Set `console: { auth: "token" }`. `console.origins` defaults to `["https://console.vitehub.dev"]`, so the hosted Console needs no other option. When you set `console.origins` yourself, keep `https://console.vitehub.dev` in the list.
2. Create a token, and set its SHA-256 hash as `VITEHUB_CONSOLE_TOKEN_SHA256` on the server, then deploy. The server keeps only the hash, so keep the token itself in a password manager.
3. Open [console.vitehub.dev](https://console.vitehub.dev), select **Link project**, enter the app URL, and paste the token. See [Link a project](#link-a-project).

```sh
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN"                          # paste this into the Console
printf %s "$TOKEN" | sha256sum | cut -d' ' -f1  # set this as VITEHUB_CONSOLE_TOKEN_SHA256
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { auth: 'token' },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    console: { auth: 'token' },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    console: { auth: 'token' },
  })],
})
```
:::
::

The hosted Console can also link a development server on `localhost` that uses `auth: "token"`. Chrome then asks for permission to reach the local network. During development, the Console at `/_vitehub` of the app is simpler.

The page sends a strict Content Security Policy. It loads scripts only from its own origin and cannot be shown in a frame. The browser lets it call `https:` origins, and `http://localhost` and `http://127.0.0.1` on any port.

Some features need the app origin, so they work only in the Console that the app serves. See [What needs the Console that the app serves](#what-needs-the-console-that-the-app-serves).

### Link a project

1. Select **Link project**.
2. Enter the app URL: its origin, with its base path if it has one, such as `https://app.example.com` or `https://app.example.com/portal`. A pasted Console URL such as `https://app.example.com/_vitehub/kv` also works.
3. The Console reads [`project.get`](#read-the-project). When the project asks for a token, paste the token that you created for it and select **Sign in**. The server keeps only its SHA-256 hash, in `VITEHUB_CONSOLE_TOKEN_SHA256`.

The Console then opens the project and shows only the sections that the project lists for this token. When linking fails, the Console says why:

| Message | Fix |
| --- | --- |
| `<console> is not in console.origins for <host>` | Add the Console origin to `console.origins`, then build and deploy again. The browser hides why a cross-origin request failed, so the project can also be offline. |
| `<host> refused this token` | Paste the token whose hash is in `VITEHUB_CONSOLE_TOKEN_SHA256`. If you lost it, create a new token and set its hash. |
| `This project runs vite-hub <version>. This Console needs protocol 1.` | Update `vite-hub` in the app. |
| `<host> cannot sign this Console in` | The project uses `auth: "app"`, but its Auth does not issue Console tokens. Add `consoleMcpOAuth()` to the app Auth. See [Link a project that signs in with the app](#link-a-project-that-signs-in-with-the-app). |

### Link a project that signs in with the app

A project with `console: { auth: "app" }` signs the Console in with its own Auth, so you do not copy a token. Each person signs in with their own account, and [`authorize`](#limit-a-user-to-some-sections) decides their sections. The project needs:

- `consoleMcpOAuth()` in the app Auth, with `@better-auth/cimd` installed.
- The Console origin in `console.origins`. The default, `["https://console.vitehub.dev"]`, allows the hosted Console. The app accepts the OAuth client of a Console only on an `https://` origin in this list.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts', origins: ['https://console.vitehub.dev'] },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts', origins: ['https://console.vitehub.dev'] },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts', origins: ['https://console.vitehub.dev'] },
  })],
})
```
:::
::

To link it:

1. Select **Link project** and enter the app URL. The project answers `401` with a challenge that names its OAuth metadata, and the Console shows **Sign in with `<host>`**.
2. Select **Sign in with `<host>`**. The browser opens the sign-in page of the app. Sign in, and choose **Allow** for the ViteHub Console.
3. The app sends the browser back to `/oauth/callback` of the Console. The Console gets the tokens, reads [`project.get`](#read-the-project), and opens the project.

The Console is a public OAuth client with no secret. Its `client_id` is the URL of its client ID Metadata Document, `<console origin>/oauth-client.json`, and its redirect URI is `<console origin>/oauth/callback`. It uses the authorization code flow with PKCE `S256` and a random `state`, and asks for `vitehub:read vitehub:write offline_access` for the Console resource `<app origin><base>/_vitehub`. Before it opens the sign-in page, it checks that the protected resource metadata names that resource, and that the authorization server supports PKCE `S256` and client ID Metadata Documents.

When the sign-in does not finish, the Console says why:

| Message | Fix |
| --- | --- |
| `The Console was not allowed` | You chose **Deny**. Sign in again and choose **Allow**. |
| `This sign-in cannot finish here` | The `state` is unknown, or the sign-in already finished. A sign-in must finish in the tab that started it. Sign in again. |
| `The sign-in took too long` | A sign-in must finish within 10 minutes. Sign in again. |
| `<host> did not issue a token` | The app refused the code, for example because it was already used. Sign in again. |
| `Cannot reach <host>` | Add the Console origin to `console.origins`, then build and deploy again. |
| `This Console was built for another origin` | The client document names another origin. Build the Console with `VITEHUB_CONSOLE_ORIGIN`, see [Self-host the Console](#self-host-the-console). |

### Start a new project

The hosted Console can start a new app for you. It needs a `vite-hub` release with `vite-hub init` ([#3523](https://github.com/vite-hub/vitehub/pull/3523)), which is not released yet.

1. Select **New project** on the empty Console, in the project menu, or in <kbd>⌘</kbd><kbd>K</kbd>. The page is at `/new`.
2. Enter the folder name and pick the host. Features that the host cannot run are greyed out and say why.
3. Pick the features. The page adds the features that they turn on, such as Database for Comments, and marks them **Added by**. When the host needs an option for a feature, such as `email.driver` on Vercel, the page asks for it.
   Console is always on and uses token auth so the one-time link can sign in from the hosted Console.
4. Once the stack has no problems, copy the command and run it in your terminal:

```bash [Terminal]
pnpm dlx vite-hub init my-app --host cloudflare --features console,kv,queue --option console.auth=token --console <id>:sha256:<verifier> --yes
```

5. On Cloudflare, Vercel, Netlify, or Deno, open the app folder and run `pnpm vitehub deploy`. This sets up the Console key on the host and prints a link. Open that link in the same browser. For Node.js, deploy the app with `VITEHUB_CONSOLE_TOKEN_SHA256` set to the verifier from `--console`. Open `https://console.vitehub.dev/link#p=<id>&url=<app-origin>` in the same browser, with `<id>` from `--console` and `<app-origin>` replaced by the URL-encoded origin of the deployed app. See [Link a new project](#link-a-new-project).

The address of the page holds the stack: the folder, the host, the features, and non-private options, such as `/new?host=vercel&features=email&option=email.driver%3Dresend`. Database connection URLs can contain credentials, so they stay only in page memory and the generated command. Enter them again after a reload or when you open a shared link. The `--console` value is not in the address, because its link works only in the browser that made it. When you change the stack after the command appears, the command changes and keeps the same link.

Creating a command needs persistent browser storage and Web Locks, which keep the key across navigation and let only one tab confirm a link. Allow browser storage and use a current browser on an HTTPS Console.

### Link a new project

A one-time link lets a new project link itself, so you do not copy a token by hand. [Start a new project](#start-a-new-project) makes the link and prints it in the `vite-hub init --console` command. That command is not released yet, and the server does not read `VITEHUB_CONSOLE_TOKEN_SHA256` yet. Until then, use [Link a project](#link-a-project) with the app URL and its token.

The hosted Console makes a random key and keeps it in this browser, in `localStorage` under `vitehub-console:pending-links`. It gives out only an id and the SHA-256 of the key. The setup command stores that hash in the app as `VITEHUB_CONSOLE_TOKEN_SHA256` and prints a link such as `https://console.vitehub.dev/link#p=<id>&url=<app origin>`. The link holds no secret.

When you open the link, the Console removes it from the address bar and asks **Link `<host>`?**. It sends nothing before you confirm. Select **Link project** only when the host is the app that you just started, because a changed link can name another host. The Console then sends the key to that app, saves the project with the key as its Console token, and deletes the one-time entry.

The link has limits:

- It works only in the browser profile that made it. Teammates use [`auth: "app"`](#use-the-app-auth), or link the project with their own token.
- It works once, and for 24 hours. A used or unknown link says `This link was made in another browser or already used`. Make a new link and run the command again.
- When the app refuses the key, its `VITEHUB_CONSOLE_TOKEN_SHA256` is not the hash of this link. Run the command again, or relink.
- The first confirmation binds the link to that app URL, also when the request fails. You can fix the app and confirm the same URL again. Another app needs a new link.
- Tabs take turns with [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), so only one tab can use a link. A browser without Web Locks, or a Console on plain `http:` outside `localhost`, cannot confirm a link.

### Switch projects

The top of the rail shows the name and the host of the open project. Select it, or press <kbd>⌘</kbd><kbd>K</kbd> and choose **Switch project**, to see the linked projects. A dot shows if each one is reachable, needs a new token, or is unreachable. The Console loads the project that you choose, and opens it again after a reload.

### Links to the hosted Console

A link can open one page of a project in the hosted Console:

```txt
https://console.vitehub.dev/open?project=<app URL>&path=<Console path>
```

- `project` is the app origin, with its base path if it has one, such as `https://app.example.com/portal`. It must be `https://`, or `http://` on `localhost`, `127.0.0.1`, or `[::1]`.
- `path` is the page in the Console, such as `/kv` or `/agents/<agent>/invocations/<id>`. It must start with one `/`. A path that starts with `/_vitehub`, as in the Console that the app serves, also works. Without `path`, the link opens the Overview.

When this browser linked the project, the Console switches to it and opens the page. When it did not, the Console opens **Link project** with the app URL filled in. Select **Continue** to link the project, and the Console then opens the page. The link holds no secret. An absolute URL or a `//` path in `path` shows `Check the Console path`, so a link cannot send the browser to another site.

To build the link in code, use `hostedConsoleUrl()` from `vite-hub/runtime`. It encodes both values, and throws a `TypeError` for a project URL or a path that the Console refuses:

```ts
import { hostedConsoleUrl } from 'vite-hub/runtime'

hostedConsoleUrl('https://app.example.com', '/agents/support/invocations/abc')
// https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fsupport%2Finvocations%2Fabc
```

A self-hosted Console takes its origin as the third argument, such as `hostedConsoleUrl(url, '/kv', 'https://console.example.com')`.

### Where the tokens are

The project list and the tokens stay in this browser, in `localStorage` of the Console origin, under the key `vitehub-console:projects`. No server keeps a copy. This has consequences:

- Each token gives Console access to its project, as far as [`authorize`](#limit-a-user-to-some-sections) allows. Anyone who uses this browser profile can read it, and so can any script that runs on the Console origin. Use a browser profile that only you use, and serve the Console from an origin that serves nothing else.
- Another browser or another Console origin has its own list. Link the projects again there.
- When the browser does not let the Console store data, such as when storage is full or blocked, the list stays in memory until the page reloads. The Console says so.
- To revoke access, remove the token's hash from `VITEHUB_CONSOLE_TOKEN_SHA256`, and restart or deploy the server. A Console that used that token then asks for a new one. See [Give each caller its own token](#give-each-caller-its-own-token).

A project that signs in with the app keeps OAuth tokens in the same entry: an access token that is valid for 15 minutes, and a refresh token that is valid for 7 days. Each refresh gives a new refresh token. The Console refreshes the access token before a request when it expires within a minute. Requests that start at the same time wait for one refresh, and tabs take turns with the Web Locks API so they do not use the same refresh token. In browsers without Web Locks, a short lease in `localStorage` coordinates active tabs. This fallback is best effort: a suspended tab can miss lease renewal and overlap another tab's refresh. When the app refuses a refresh token that another tab already rotated, the Console uses the tokens that the other tab saved. When the project refuses an access token with `error="invalid_token"`, the Console refreshes once and sends the request again. When the refresh fails, the Console removes the tokens and asks you to sign in again. While a sign-in runs, the PKCE verifier and the `state` stay in `sessionStorage` of the tab, under `vitehub-console:oauth-sign-ins`. Each `state` works once. A browser that blocks site data for the Console keeps nothing across the redirect to the app, so the Console does not start a sign-in there and says `This browser blocks site data`. Allow site data for the Console origin, or use `auth: "token"`.

`localStorage` is the trade-off of a Console with no server: a script on the Console origin can read the tokens, the same as a Console token. The short access token and the refresh token that the app can revoke limit the damage. An access token that a script copied stays valid until it expires, at most 15 minutes.

To remove a project, open the project list, select the **×** next to the project, and confirm **Forget project**. The browser removes the URL and the tokens. For a project that signs in with the app, the Console also revokes the refresh token at the revocation endpoint of the app. **Sign out** in the account menu revokes it and keeps the project in the list. The revocation is best effort: when the app does not answer, the refresh token stays valid until it expires. The project does not change.

The Console that an app serves also uses this storage. With `auth: "token"`, `/_vitehub` asks for the token, keeps it in `localStorage` of the app origin, and **Sign out** in the account menu removes it.

### What needs the Console that the app serves

Some features act on the app's own pages or set cookies of the app, so they work only in the Console at `/_vitehub` of the app. In production, an app serves that Console only with `console.embed: true`. A Console on another origin hides or turns them off, and links to the app's Console where that helps:

- Live editing of Content documents. The editor saves alone, and saves still refuse to overwrite a newer version.
- The Content page preview.
- Impersonation of Auth users.
- The connect flow of Connections.
- Env management: values, Access, and Activity. The Env bridge accepts calls only from the app origin.
- Image previews from a Blob serve route that needs the app session. The Media library shows the file type instead.
- The app session account menu, and the page tools of the app's pages.

### Self-host the Console

The hosted build is a static site, so any static host can serve it. Build it in a clone of the [ViteHub repository](https://github.com/vite-hub/vitehub):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run -t vite-hub#build
corepack pnpm --dir packages/vite-hub run build:console-hosted
```

The last command writes `index.html`, `404.html`, `_headers`, `oauth-client.json`, and `assets/` to `packages/vite-hub/.vitehub/console-hosted`.

`oauth-client.json` is the client ID Metadata Document of the Console. It names absolute URLs, so the build needs the origin that serves the Console. It defaults to `https://console.vitehub.dev`. To sign in to projects with `auth: "app"` from your own origin, set `VITEHUB_CONSOLE_ORIGIN` when you build. It must be an `https://` origin with no path:

```sh
VITEHUB_CONSOLE_ORIGIN=https://console.example.com corepack pnpm --dir packages/vite-hub run build:console-hosted
```

A Console that runs on another origin than its document names cannot sign in with OAuth, and says so. Projects with `auth: "token"` still work.

When you serve that folder:

- Serve it from an origin that serves nothing else, because every script on that origin can read the tokens.
- Answer unknown paths with `index.html`, so Console routes such as `/kv` load the app.
- Send the headers in `_headers`. Cloudflare and Netlify read that file. On other hosts, set the same headers. When a project uses `http:` on a host other than `localhost` or `127.0.0.1`, add it to `connect-src`.
- Add the Console origin to `console.origins` of each project.
- Serve `oauth-client.json` at the root as JSON. Apps fetch it to know the Console.

On Cloudflare, `packages/vite-hub/console.hosted.wrangler.jsonc` is the configuration of console.vitehub.dev: a Worker with static assets and no Worker script. Copy it into the same folder, because `assets.directory` is relative to the file. Change `name` and `routes`, build, and run `wrangler deploy --config <file>`.

## Develop against a fixture

Use `vitehub console dev` to get the same Agent Invocations (Agent runs) on every restart. It validates a versioned JSON fixture, then runs the command after `--` with an in-memory Console journal. It does not write the default Agent journal at `.vitehub/data/agent-invocations.sqlite`.

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

The Console registers its page and assets under `/_vitehub/**` and its RPC route under `/_vitehub/rpc/**`. Provider status uses `GET /_vitehub/api/status`. It serves the [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-your-app) as static files under `/_vitehub/.well-known/skills/`, so `npx skills add <app>/_vitehub` installs the skill of your `vite-hub` version. These files need no sign-in.

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
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

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
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

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
    ],
  },
})
```

The `role` field comes from Better Auth's `admin()` plugin. Use the app's role, permission, or allowlist. To give your account the admin role on a fresh deploy, set `VITEHUB_ADMINS`. See [Give the first admin role](/docs/auth/configure#give-the-first-admin-role). To keep users and sessions across restarts, use [`authDatabase()`](/docs/auth/configure#keep-users-in-the-app-database).

- No session returns `401`.
- After sign-in, the callback gets the request and the signed-in `user`.
- `false` returns `403` and offers **Switch account**.
- A custom `Response` sets the rejection or redirect.

ViteHub requires an authorization callback for every Console route, including `GET /_vitehub/api/status` and, when enabled, `GET /_vitehub/api/usage`. The wildcard route above covers them. Missing policy stops the build with `VITE_HUB_B0006`. Missing app Auth stops it with `VITE_HUB_B0005`. `console: true` never grants access to every signed-in user by itself.

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
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

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
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

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

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and [`VITEHUB_SECRET`](/docs/env/app-secret) in the server environment. Console Auth signs sessions with a secret derived from `VITEHUB_SECRET`; `BETTER_AUTH_SECRET` wins when it is set, and `secretEnv` names another required variable. Rotating either secret signs out every Console session. `baseURL` is the public origin used for OAuth redirects; set it when a proxy terminates TLS. The GitHub callback URL is `https://agent.example.com/_vitehub/api/auth/callback/github`. For Nuxt apps mounted below `/`, ViteHub includes `app.baseURL` in the callback and redirects. Put `databasePath` on persistent storage. Console Auth creates or updates its Better Auth tables before the first protected request. It refuses a missing database or secret. Application requests and channel requests keep their own authentication.

If you previously protected the Console through Primary Auth, remove its `/_vitehub/**` access route when you switch to Console Auth. Keep `auth: true` if application routes still use Primary Auth. Otherwise, both auth guards apply and maintainers must sign in twice.

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

ViteHub sets the auth route to `/_vitehub/api/auth/**` and the cookie prefix to `vitehub_console`. It guards `/_vitehub/**`, including RPC and invocation actions, but not the sign-in page and callback. A signed-out visit opens `/_vitehub/sign-in`, and the provider redirect starts when the user selects its button. Console APIs return 401 without a session. The server file must give a Better Auth database adapter on durable storage and a secret. ViteHub runs Better Auth migrations before the first protected request. Set `migrate: false` only when your own startup applies the schema.

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

### Use a Console token

`auth: 'token'` protects the Console data routes with one secret. Use it for an app without sign-in, for the CLI, and for a Console on another origin.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { auth: 'token' },
    kv: true,
    preset: 'node',
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    console: { auth: 'token' },
    kv: true,
    preset: 'node',
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
    console: { auth: 'token' },
    kv: true,
    preset: 'node',
  })],
})
```
:::
::

The server never stores the token. It reads only its SHA-256 from the `VITEHUB_CONSOLE_TOKEN_SHA256` environment variable on each request, so a person or tool that reads the host env, or a pulled `.env` file, does not get a working token. The build does not contain it. Create a token, keep it where you keep secrets, and set its hash in the host environment:

```bash [Terminal]
TOKEN=$(openssl rand -hex 32)
printf %s "$TOKEN" | sha256sum   # 64 hex characters
# Node and most hosts: set the hash in the server environment
VITEHUB_CONSOLE_TOKEN_SHA256=<hash> node .output/server/index.mjs
# Cloudflare
wrangler secret put VITEHUB_CONSOLE_TOKEN_SHA256
```

Each caller sends the token as `Authorization: Bearer <token>`. The server hashes it with SHA-256 and compares the two digests in constant time. A missing, wrong, or short token (fewer than 32 characters) gets `401` with `CONSOLE_TOKEN_INVALID` and `WWW-Authenticate: Bearer realm="vitehub-console"`. When no token hash variable is set, or one of them is not 64 hex characters, every request gets `500` with `CONSOLE_TOKEN_NOT_CONFIGURED`. The server does not accept the token itself as `VITEHUB_CONSOLE_TOKEN`: with only that variable set, the diagnostic says to store the hash instead. Cookies and sessions never count in this mode.

The CLI sends `VITEHUB_CONSOLE_AUTHORIZATION` as the `Authorization` header, with the token, not the hash:

```bash [Terminal]
VITEHUB_CONSOLE_AUTHORIZATION="Bearer $TOKEN" vitehub logs list --url https://app.example.com
```

A token caller gets every Console section. Set `console.authorize` to limit it. The context has `via: 'token'` and no `user`. An Agent that calls Console operations as tools gets `via: 'agent'` and never `via: 'token'`, so allow it on its own:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ via }) => {
  if (via === 'token') return { sections: ['kv', 'logs:read'] }
  if (via === 'agent') return { sections: ['kv:read'] }
  return false
})
```

::warning
The token is a bearer secret: anyone who has it can use the Console. Keep it out of source code and client bundles.
::

### Give each caller its own token

Next to `VITEHUB_CONSOLE_TOKEN_SHA256`, the server reads every variable named `VITEHUB_CONSOLE_TOKEN_SHA256_<NAME>`, where `<NAME>` has capital letters, digits, and underscores. Give each caller its own token and its own variable, such as one for a Console and one for the CLI in CI:

```bash [Terminal]
VITEHUB_CONSOLE_TOKEN_SHA256_CONSOLE=<console hash> \
VITEHUB_CONSOLE_TOKEN_SHA256_CI=<ci hash> \
node .output/server/index.mjs
```

Hosts never give a secret back, so a command can add or remove its own variable without reading the others. Removing one variable revokes only that caller. The server compares the token with every hash, so the time of the check does not show which one matched. A variable that is not 64 hex characters refuses every request with `CONSOLE_TOKEN_NOT_CONFIGURED`, and the message names it.

To rotate a token with no downtime, add a variable with the hash of the new token and deploy. Give the new token to the caller, then remove the old variable and deploy again. The old token stops working at once.

The Console page on the app's own origin cannot send the token yet, so with `auth: 'token'` it opens in its signed-out state. Use the CLI, MCP, or a Console on another origin.

### Call the Console from another origin

A Console on another origin, such as the hosted Console at `https://console.vitehub.dev` or a Console that you host yourself, calls the app's Console data routes from the browser. `console.origins` lists the origins that may do this:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: {
      auth: 'token',
      origins: ['https://console.vitehub.dev', 'https://console.example.com'],
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    console: {
      auth: 'token',
      origins: ['https://console.vitehub.dev', 'https://console.example.com'],
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    console: {
      auth: 'token',
      origins: ['https://console.vitehub.dev', 'https://console.example.com'],
    },
  })],
})
```
:::
::

`origins` defaults to `['https://console.vitehub.dev']`. Set `origins: []` to turn cross-origin calls off. Each entry is an `https://` origin, or an `http://` origin on `localhost` or `127.0.0.1` for development. An entry has no path, query, or trailing slash. The build fails on any other value.

The server accepts a cross-origin call only when all of these are true:

- `console.origins` lists the `Origin` of the request.
- `console.auth` is `'token'`.
- The request sends the token as `Authorization: Bearer`, and the token is correct.

Cookies never authorize a cross-origin call, so another site cannot use a signed-in browser session. A call from an origin that is not listed gets `403` with `CONSOLE_ORIGIN_REJECTED`. The other `auth` modes keep every Console data route same-origin.

The rule covers the Console data routes: the RPC at `/_vitehub/rpc/__call` and `/_vitehub/rpc/__upload`, Auth management at `/_vitehub/auth/manage`, Env management at `/_vitehub/env/manage`, Channel replay at `/_vitehub/channels/replay`, and Schedule runs at `/_vitehub/schedules/run`. Env management still authenticates the request with its provider and checks the provider permissions. A Schedule run with a signed dispatch keeps the signature as its own authority. Without a signature, the route takes the Console token as `Authorization: Bearer` with `auth: 'token'`, and needs the full `schedules` grant. A session runs a Schedule through the RPC instead.

The responses to a listed origin carry `Access-Control-Allow-Origin: <origin>`, `Access-Control-Expose-Headers: WWW-Authenticate`, and `Origin` in `Vary`. They never carry `Access-Control-Allow-Credentials`. A Nitro plugin answers the `OPTIONS` preflight of these routes before every app middleware, including the files in `server/middleware/`, and before app Auth. A listed origin gets `204` with `Access-Control-Allow-Methods: POST` and `Access-Control-Allow-Headers: authorization, content-type, x-vitehub-console`. Any other origin gets `403` with `CONSOLE_ORIGIN_NOT_ALLOWED`. The actual call then goes through your middleware as usual, so middleware that requires a session must let the Console data routes through and leave the check to the Console.

Check the setup with curl:

```bash [Terminal]
curl -i -X OPTIONS https://app.example.com/_vitehub/rpc/__call \
  -H 'Origin: https://console.vitehub.dev' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type'
curl -i https://app.example.com/_vitehub/rpc/__call \
  -H 'Origin: https://console.vitehub.dev' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"operation":"sections.list","input":{}}'
```

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
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

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
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

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

```ts [server/console-authorize.ts] fragment
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
| `auth: 'token'` | Compares the SHA-256 of `Authorization: Bearer` with `VITEHUB_CONSOLE_TOKEN_SHA256`. Returns `401`, or `500` when the hash is not set or is malformed. Accepts a cross-origin call from `console.origins`. |
| `auth: { ... }` | Checks the Console Auth Session and its `authorize` callback with `withAuthorization()`. Returns `401` or `403`. It does not redirect to sign-in. |
| `auth: { provider: 'cloudflare-access' }` | Verifies the Cloudflare Access token. Development has no Access edge, so the development server allows the request. |
| `authorize` | Runs after any check above. It can reject the request or limit it to some sections. |

All Console paths here sit under the application base: an explicit ViteHub application base (set from Nuxt `app.baseURL`), else a root-relative Vite `base`.

- With `base: '/portal/'`, host middleware must protect `/portal/_vitehub/**` for every method, including assets, RPC, and invocation actions. Update host policies when you change the base or upgrade to base-aware routes.
- Absolute and protocol-relative bases, such as `https://cdn.example/portal/` and `//cdn.example/portal/`, are asset CDN URLs. Without an explicit application base, protect `/_vitehub/**` at root. Relative bases (`''` or `'./'`) also use root routes.
- When Nitro `baseURL` matches the application base, Nitro adds it once, so the Console is at `/portal/_vitehub`.
- Primary Auth access routes must use the application base too. Built-in Console Auth adds it for you.

### Share a development server

A Console without sign-in trusts whoever can reach it, so in development it answers only this machine. A tunnel or a reverse proxy on this machine, such as `cloudflared`, `ngrok`, `tailscale serve`, an `ssh -R` tunnel, or Caddy, connects to the dev server from `127.0.0.1` too. To share a dev server through one, set `console.auth` to `"app"` or a Console Auth config.

ViteHub refuses the forwarded requests that it can recognize:

- A `Host` other than `localhost`, a `.localhost` name, `127.0.0.1`, or `[::1]`.
- A forwarding header: `Forwarded`, `Via`, any `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, `CDN-Loop`, any `CF-*`, `Fly-Client-IP`, `Fastly-Client-IP`, `X-Vercel-Forwarded-For`, any `Ngrok-*`, or any `Tailscale-*`.

A forwarder that copies raw TCP bytes, such as `ssh -R` or `tailscale serve --tcp`, adds no header, so ViteHub cannot tell its requests from yours. Only sign-in protects a dev server behind one. A local reverse proxy that adds `X-Forwarded-For`, such as Caddy, also gets `403` until you set `console.auth`.

When the Console has no sign-in, the dev server prints this at startup. A server that listens on more than loopback, for example with `--host`, prints it as a warning.

```txt
[vitehub] The Console has no sign-in and answers only this machine. Set console.auth before you share this dev server through a tunnel or a proxy: https://vitehub.dev/docs/development/console#share-a-development-server
```

### Open the Console from the app's pages

The ViteHub tools pill shows at the bottom of the app's pages for people the Console lets in. Its **Console** button opens the Console in a floating window, next to page tools such as [Comments](/docs/comments/configure#turn-comment-mode-on-and-off).

With `auth: 'app'`, sign in and open any page to see the pill. It also shows after you open the Console, or on a page with the `?vitehub` query.

The pill uses the Console access check, for any section. People the Console rejects do not get it. An `authorize` result with at least one section, such as `{ sections: ['content'] }`, allows it. With the development default, the pill exists on the development server only.

- **Turn off ViteHub tools** (the **×**) hides the pill until you open the Console, use `?vitehub`, or sign in again. You can drag the small mark it leaves: the pill opens where you drop it.
- The ViteHub mark collapses the pill to a small hexagon 2px from the screen edge. It stays collapsed on the next pages until you select the mark. Open windows and comment mode stay as they are.
- Drag the mark to dock the pill on another edge, where you release it. On the left and right edges, the mark and **×** share the first row and the tools stack below. Windows open from the docked edge. The browser remembers the place.

#### Keep the pill off your own toolbar

A page with its own bar where the pill docks, such as a review toolbar at the bottom center, can move the pill aside. Set `data-vitehub-pill="mark"` on `<html>`. The pill folds to the ViteHub mark and moves to the nearer end of the bottom edge. Remove the attribute and the pill comes back as it was. In Nuxt, set it from the page or component that draws the bar:

```ts fragment
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

It needs app Auth with Better Auth's [admin plugin](https://www.better-auth.com/docs/plugins/admin) and the [Auth event log](/docs/auth/events), which records each start and stop. Without app Auth, the build stops with `VITE_HUB_B0005`. This example keeps users and events in a Database Definition named `auth`:

```ts [server/databases/auth/config.ts]
import { defineDatabase } from 'vite-hub/database'

export default defineDatabase({ name: 'auth', schema: {} })
```

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
import { vitehub } from 'vite-hub'

vitehub({
  connections: { management: true },
  console: { auth: 'app', authorize: './server/console-authorize.ts' },
  database: true,
  preset: 'node',
})
```

> [!WARNING]
> Every user with the `connections` section can then manage every Connection. Limit the policy to the people who own the provider accounts.

In `vite dev`, a Console without sign-in (`local` access, or `console: { auth: false }`) answers only loopback requests. A request with a `Host` other than `localhost`, `127.0.0.1`, or `[::1]`, a peer address that is not loopback, or any forwarding header gets `403` with `CONSOLE_LOOPBACK_ONLY`. See [Share a development server](#share-a-development-server). This does not apply to production servers, so set `console.auth` or `console.authorize` for them.

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

The Console does not store Agent Invocations. It reads the app-wide journal that `@vite-hub/agent` installs, with the Console on or off. When Agents are configured and no journal is set, that is the default journal at `.vitehub/data/agent-invocations.sqlite`. It retains invocation records and selected searchable text, including prompts, messages, final text, progress updates, and generated session titles. See [the default journal](/docs/agents/invocation-storage#use-the-default-journal) for its options, location, and retention. A KV-only Console does not read an Agent journal or install Agent read endpoints.

Earlier releases stored this journal at `.vitehub/data/console.sqlite` and read `console.databaseUrl`, `console.observations`, `console.retention`, and `VITEHUB_CONSOLE_DATABASE_URL`. These options are removed. A build that sets one of them fails with `VITE_HUB_B0020`, and a server that sets `VITEHUB_CONSOLE_DATABASE_URL` fails with `AGENT_R1032`. Set `agent: { invocations: { databaseUrl, observations, retention } }` and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` instead. ViteHub does not move records from `console.sqlite`. To keep them, set `databaseUrl` to the old file, or pass it to [`vitehub agent invocations`](/docs/agents/invocation-storage#inspect-and-maintain-from-the-cli) with `--database`.

Console image uploads use the configured Blob store. Before each new upload, the Console retries at most 100 pending rollback records. Malformed batch records move unchanged to `_vitehub/console/quarantine/batch/<id>`. New uploads continue, but stored attachment references stay unavailable while any quarantine record exists, because their delete owner is unknown. Quarantine deletes no image bytes.

To repair a quarantined record:

1. Get its original attachment UUIDs from trusted storage history.
2. Write their JSON array (1–10 UUIDs) to `_vitehub/console/cleanup/batch/<id>` for new quarantines, or `vitehub-console-attachment-cleanup/<id>` for legacy ones.
3. After a later upload drains that cleanup record, delete the quarantine object through the Blob provider.

If you cannot get the original UUIDs, keep the quarantine record. Guessing can delete kept images.

In production, the operator must still decide how long to keep records that may contain sensitive data. Workflow, Queue, and Schedule inspection do not use the journal. Workflow and Queue do not expose run or message history because ViteHub does not yet have provider-independent contracts for listing that operational data. The Schedule page lists the discovered Schedule Definitions. Definitions with `manual: true` show a run action when Console invocation is enabled; use [`vitehub schedule`](/docs/development/cli#run-and-inspect-schedules) to run them or list recorded runs, in development or on a deployment with `--url`.

A journal from `defineAgent({ invocations })` or from the app-wide `agent.invocations` option replaces the default journal. The Console reads that journal instead, so development uses one journal. An Agent with `invocations: false` records no sessions. With `agent: { invocations: false }`, the Console lists no sessions.

An Agent records in the default journal whether you import `defineAgent` from `vite-hub/agent` or from `@vite-hub/agent`, because both paths export the same function.

The Agent Console uses an invocation journal configured on the discovered Agent Definition. Configure the same journal on every discovered Agent when the Console includes more than one. Set [`agent.invocations`](/docs/agents/invocation-storage#use-one-journal-for-every-agent) to give all of them the same journal. Distinct journals fail during runtime setup because the Console exposes one combined query interface.

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
| Agents opens but has no sessions | Invoke a discovered Agent. Confirm it uses the default journal or the app-wide `agent.invocations` journal, not a separate `invocations` store. |
| Sandboxes is absent from the Console home | Configure `sandboxTask: true` with a deployment preset that supports Sandbox Tasks. |
| `console: true` reports missing app Auth or Console access policy | Set `auth: true` and allow the Console routes in the app Auth Definition. Use `console: { auth: false }` only when you want no sign-in. |
| ViteHub says `console.auth` is required (`VITE_HUB_B0004`) | Add `auth` to the `console` object: `false`, `'app'`, or a Console Auth config. |
| `auth: 'app'` fails with `VITE_HUB_B0005` | Set `auth: true` and add an Auth Definition, such as `server/auth.ts`. |
| `auth: 'app'` fails with `VITE_HUB_B0006` | Set `console.authorize`, or add Auth access routes with an `authorize` callback for the routes in the message. |
| The build or server warns that `auth: false` has no sign-in | Add `console.authorize`, or set `console.auth` to `'app'` or a Console Auth config. |
| Console data routes return `500` with "console.authorize must return" | Return `true`, `false`, a `Response`, or `{ sections: string[] }` from `authorize`. Use the global `Response`. A Response-like object, or a Response from another Fetch implementation, is invalid. |
| Agent Console startup fails on a hosted preset | Set `agent.invocations: 'database'`, or give every Agent Definition one durable journal. The default SQLite journal needs a writable, persistent filesystem. |
| The page returns `401` | Sign in through the host's Auth provider. |
| The page returns `403` with **Access denied** | `authorize` or the `auth` check rejected this account. Check the callback and the user's role or permission. |
| A section is missing or returns `403` | `console.authorize` returned `{ sections }` without that section id. |

### Console error codes

A `401` from a Console data route carries `WWW-Authenticate: Bearer realm="vitehub-console"`. The MCP endpoint keeps its own challenge with `resource_metadata`.

Each failed Console request returns JSON with a stable `code`, a `message` that says why, a `fix`, and a `docs` link. RPC failures also keep `ok: false` and `status`. The Console shows one next step: sign in again, reload, try again, or read the docs. It offers a retry only when a retry can work.

| Code | Status | Fix |
| --- | --- | --- |
| `CONSOLE_SIGN_IN_REQUIRED` | `401` | Sign in again. |
| `CONSOLE_ACCESS_DENIED` | `403` | Sign in with an account that the access policy allows. |
| `CONSOLE_MANAGER_REQUIRED` | `403` | The session has no user id, so a management action cannot name its manager. Make sure the Auth Definition that protects the Console returns a user with an id. |
| `CONSOLE_IMPERSONATING` | `403` | This browser uses an impersonation session. Stop impersonating to get your own session back. |
| `CONSOLE_DEVELOPMENT_ONLY` | `403` | Rebuild and deploy with an explicit `console.auth` choice. Use `console: { auth: 'app' }` with the Primary Auth Definition, or configure a Console Auth session. Set `console.authorize` to restrict who may use it. |
| `CONSOLE_ORIGIN_REJECTED` | `403` | Open the Console from its own URL. Proxies must forward the public `Host` and `Origin` headers. For a Console on another origin, see [Call the Console from another origin](#call-the-console-from-another-origin). |
| `CONSOLE_ORIGIN_NOT_ALLOWED` | `403` | Add the origin to `console.origins`, use `auth: 'token'`, then build and deploy again. |
| `CONSOLE_TOKEN_INVALID` | `401` | Send `Authorization: Bearer` with the token whose SHA-256 is in `VITEHUB_CONSOLE_TOKEN_SHA256`. For the CLI, set `VITEHUB_CONSOLE_AUTHORIZATION="Bearer <token>"`. |
| `CONSOLE_TOKEN_NOT_CONFIGURED` | `500` | Set `VITEHUB_CONSOLE_TOKEN_SHA256` to the SHA-256 of the token as 64 hex characters (`printf %s "$TOKEN" \| sha256sum`), remove `VITEHUB_CONSOLE_TOKEN`, then restart or deploy. |
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

A route that fails with its own diagnostic keeps that code, such as `VITE_HUB_R0114`. Connections and Env management routes keep their `CONNECTION_*` and `ENV_BRIDGE_*` codes and add `fix` and `docs`.

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

Choose **Console** to open it in a floating window. Content lives in the Console's Content section, so the pill has no separate Content button. To change text on the page itself, use **Edit** in the [Comments](/docs/comments/configure#mark-content-fields) segment: a click on a field marked with `contentField()` edits its text in place, and a field that is not plain text opens its document in the Console window. Content's own read, write, and publish policies still apply.

When the page belongs to a document with an unpublished saved draft, the Console segment shows **View draft**. The pill finds the document from the collection `url` patterns, and shows the button only for documents you may read. **View draft** loads the page with that draft through a [preview frame](/docs/content/preview#preview-frames) form in this tab. Only this document shows as a draft, only your browser sees it, and the token stays in the form body.

On the draft page, a **Draft** tab sits on the pill, on the side facing the page, and the page has no banner. The tab marks text blocks that differ from the live page, such as headings, paragraphs, and list items. **N changes** turns the marks off and on. The pill compares the text of each block with the live page in a hidden frame, so a moved paragraph is not a change. Images, links, and styles are not compared. Removed blocks are counted. The tab hides while the pill is collapsed. **Back to live** shows the page as guests see it. Client-side navigation shows the next page live and checks it for a draft. The draft view shows the saved draft, not unsaved text.

Expanding or minimizing the window keeps the document and unsaved text.

- **Open in new tab** in the title bar opens the window's page in a full tab, with the same section, record, and filters. A middle-click or <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-click opens it in the background. **Copy link** copies it. The window stays open with its unsaved text.
- On a phone, the editor fills the screen.
- Client-side navigation keeps the editor open on its document. A full reload loses unsaved text, so the editor asks before you leave.
- The browser remembers the window size and editor route. The pill stores no document values.

The editor loads on first use. In production it uses a same-origin iframe and needs an accepted Console session. A normal Console page still refuses framing. `?embed=1` allows same-origin framing only after the access check. Your Content Security Policy must allow the same-origin frame.

Comments uses the same window for the page's threads and replies, without **Open in new tab**. Its **Edit** action edits plain-text fields in place. A field that is not plain text opens its document in Console. Without the Console tool, **Open Content** links to the Content page. The Comments and Content policies still apply.

## Inspect logs

[Logs](/docs/logs) uses Evlog for request capture, structured fields, redaction, sampling, and drains. Explorer and Stream show the selected event in the right inspector. The CLI reads the same source with `pnpm vitehub logs list --level error --json`.

[Get started](/docs/logs/get-started) with a temporary development buffer, or [connect an existing backend](/docs/logs/configure#read-an-existing-backend) for production. Follow polls the newest page every two seconds and can miss events. See [limits and errors](/docs/logs/limits-and-errors) for retention and inspection limits.
