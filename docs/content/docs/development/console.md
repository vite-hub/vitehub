---
title: Console
description: Open your app in the ViteHub Console, and protect the endpoint that it calls.
navigation.order: 32
navigation.group: Local tools
icon: i-lucide-monitor-dot
---

The ViteHub Console is a web app at [console.vitehub.dev](https://console.vitehub.dev). It shows the primitives that your app turned on, and it can open many apps. Your app does not serve a Console page, a Console MCP, or a Console sign-in. It serves one Console route, which only the Console and the `vitehub` CLI call, with [signed requests](#sign-console-requests):

| Route | Use |
| --- | --- |
| `POST /_vitehub/rpc` | The Operations endpoint. Each request carries one [birpc](https://github.com/antfu-collective/birpc) call, as the next section shows. An [operation](/docs/development/operations) is a named action, such as `invocations.list` or `content.publish`. |
| `GET /_vitehub/rpc?ticket=<ticket>` | Redeems a [one-time link](#one-time-links), such as a Content preview or [impersonation](/docs/auth/console#changes-and-limits). The browser opens it. |
| `/_vitehub/.well-known/skills/` | Static files of the [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-your-app) for `npx skills add`. |

Agents connect to the ViteHub MCP of the Console, not to your app. See [ViteHub MCP](/docs/development/mcp).

## Call format

Each `POST /_vitehub/rpc` request carries one birpc request message as JSON. `m` is the operation name, `a` holds its input, and `i` is an id that the reply repeats:

```json [Request]
{ "m": "sections.list", "a": [{}], "t": "q", "i": "V1StGXR8_Z5jdHi6B-myT" }
```

The response carries one reply. `r` holds the value. The HTTP status is `200`, or the status that the operation sets, such as `202`:

```json [Response]
{ "t": "s", "i": "V1StGXR8_Z5jdHi6B-myT", "r": { "sections": ["agents", "kv"] } }
```

A failure has `e` instead of `r`, with the diagnostic `code`, `message`, and `status`, and `fix`, `docs`, or `details` when the failure has them. The HTTP status is the same `status`. A failure never contains a stack. A request that the endpoint cannot read, such as a body over the limit, gets a reply without `i`. Only own operation names run: `toString`, `constructor`, `__proto__`, and other unknown names get `404` with `Console operation not found.`

The sections are Auth, Env, Agents, Skills, Served skills, Channels, Usage, MCP client, Logs, Content, Comments, Blob, Databases, Email, KV, Rate Limits, Sandbox Tasks, Workspaces, Workflows, Queues, and Schedules. The Console shows only the sections that the app installs and that [`authorize`](#limit-a-user-to-some-sections) allows.

The build and the development server include only the Console routes and server code of the sections that the app turns on. An app without Agents has no Agent routes, and an app without a document editor owner, such as [Content](/docs/content), has no document editor or media library code.

- **Channels** lists the Channels of your Agents, their threads, and each conversation with its attachments and the runs that answered. You can download a conversation as Markdown or JSON. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).
- **Content** shows when `server/content.ts` defines document collections. It saves drafts, publishes, and restores revisions. `content.can()` decides what each user may do. See [Edit Content in the Console](/docs/content/console).
- **Comments** shows when the app turns on [Comments](/docs/comments/configure#turn-comments-on-in-a-vitehub-app). It lists the threads that people left on the app's pages.
- **Served skills** shows when the app has `server/skills.ts`. It lists the [Agent Skills that the app serves](/docs/development/skills#turn-skills-on-and-off) to coding agents, with a switch for each one.
- **Blob** lists stores and pages of object metadata. It uploads (up to 8 MiB) and deletes objects with `blob.put` and `blob.delete`.
- **Database** lists found Definitions (the files that declare each resource), their source, definition mode, and table names, without connecting to a database.
- **KV** lists stores and keys. It fetches a value only when you select its key. It edits and deletes with `kv.set` and `kv.delete`.
- **Rate Limit** lists policies. It reads or resets the counter of a key you enter with `rate-limit.peek` and `rate-limit.reset`.
- **Sandbox**, **Workspace**, **Workflow**, and **Queue** list Definitions and their source without starting runtime resources.
- **Schedule** lists Schedule Definitions with their cron expression and time zone. It runs a Definition that sets `manual: true`.

> [!WARNING]
> Console data can contain user prompts, model output, tool activity, Blob metadata, provider metadata, and stored KV values. Protect the endpoint before you put the app on a production URL.

## Open your app in the Console

The `console` option has three states:

| `console` | Development server | Production build |
| --- | --- | --- |
| Not set | The [Operations endpoint](/docs/development/operations#access) answers loopback requests, so `vitehub <command>` works. | Nothing under `/_vitehub`. |
| `false` | Nothing under `/_vitehub`. | Nothing under `/_vitehub`. |
| `true` or an object | The Console endpoint with the configured access policy. | The Console endpoint with the configured access policy. `auth: false` is refused. |

With `console: false`, ViteHub registers no Console RPC route, Console Nitro plugin, or Console public asset path, also on a development server. Commands such as `vitehub kv` and `vitehub schedule run` cannot reach the development server then. Remove the option to get the development endpoint back.

### In development

The Console calls each app from its server, so it cannot reach a `vite dev` server on your machine. During development, use the [`vitehub` commands](/docs/development/cli). Without a `console` option, `vite dev` serves the Operations endpoint for them, and answers only this machine. `console: { auth: false }` works the same way. See [Share a development server](#share-a-development-server).

```bash [Terminal]
pnpm vitehub project info
pnpm vitehub kv list
```

To use the Console UI, deploy the app and link it as the next section shows.

### In production

[console.vitehub.dev](https://console.vitehub.dev) is the Console as its own app, [`@vite-hub/console`](https://github.com/vite-hub/vitehub/tree/main/packages/console). Sign in with GitHub or a passkey. Each account has a personal team, and you can make more teams and invite people. A team's projects open in any browser where a member signs in. The sidebar lists the team's apps, **Members** to invite people and remove them, and **Settings** for your name, GitHub sign-in, and passkeys. Invitations are links that you send yourself. The Console sends no email.

The Console server keeps an Ed25519 key pair for each linked project, with the private key encrypted, and [signs](#sign-console-requests) each call to the project's Console endpoint with it. The signature names the person who calls. The app keeps only the public key, and the browser never sees the private key.

To open a deployed app there:

1. Set `console: true` and deploy.
2. Open [console.vitehub.dev](https://console.vitehub.dev) and sign in. **Get started** asks for the app URL. Later, select **+** next to **Apps** in the sidebar.
3. The Console shows a variable and its value, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>`. Set it on the server, deploy, and select **Check connection**.

Each link has its own variable, so the app can keep other keys next to it, such as the key of the CLI. To unlink a project, unlink it in the Console and remove its variable from the app.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: true,
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
    console: true,
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
    console: true,
  })],
})
```
:::
::

To limit who may use which section, see [Limit a user to some sections](#limit-a-user-to-some-sections).

The Console does not turn on [Comments](/docs/comments). Add `server/comments.ts` or set `comments: true` to get the **Comments** section.

## Read the project

The `project.get` operation tells a client what the project runs and what the caller may use. Each section and each operation is one that the app installs and that [`authorize`](#limit-a-user-to-some-sections) allows for the caller. A read-only grant, such as `"kv:read"`, leaves out the operations that change state. Every caller that passes Console access can read it.

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
  "operations": ["definitions.list", "documents.action", "env.get", "kv.delete", "kv.get", "kv.has", "kv.list", "kv.set", "media.action", "project.get", "sections.list"]
}
```

`protocol` is the version of this answer. A client stops when the protocol is one that it does not know. `vitehub` is the version of the `vite-hub` package that the app runs. An operation that reads its section from the input, such as `documents.action`, is in the list, and each call checks its section again.

## Inspect environment declarations

Env searches declared Server Env variables and filters them by source. A variable shows its provider, secret flag, and whether it is required or has a default.

Env does not read secret values, call providers, or check credentials. Values and defaults stay hidden. The Console does not change Env values. Change host values in your deployment configuration. Set `env: false` in the ViteHub options to turn off Env and its section.

## Manage Connections

The Console has no Connections section. To connect a provider account, use [`vitehub connections`](/docs/connections) against the app. In production, it needs the Connections management API with your own `actor` policy: `connections: { management: { actor: './server/connections-actor.ts' } }`.

## Connect to MCP servers

Set `console.mcpClient` to `true` to add the MCP client section. It runs on the server and connects to MCP servers over Streamable HTTP as the Console caller. It lists and calls their tools, reads their resources, gets their prompts, and shows each result as the server sent it.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { mcpClient: true },
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
  plugins: [
    vitehub({
      console: { mcpClient: true },
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
      console: { mcpClient: true },
    }),
  ],
})
```
:::
::

The section uses the MCP SDK. Install it in your app first:

```sh
pnpm add @modelcontextprotocol/sdk
```

The section lists the MCP server that the app announces in its [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata at `/.well-known/oauth-protected-resource`, such as its own `/mcp`. **Connect** also takes the URL of another server. URLs must use HTTPS. Plain HTTP works only for this app and `localhost`. The same rule applies to OAuth endpoints and every redirect.

### Sign in with OAuth

When a server answers `401`, the section starts the [MCP authorization flow](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):

1. It reads the protected resource metadata that the `WWW-Authenticate` header names, then the metadata of the authorization server, with RFC 8414 or OpenID Connect discovery.
2. It registers a public client with dynamic client registration (RFC 7591), and reuses registrations for the same MCP resource and callback URL.
3. The browser opens the authorization URL with PKCE `S256`, `state`, and `resource` (RFC 8707). The authorization server sends the browser back to `/_vitehub/mcp-client/callback`, and the server exchanges the code. It checks a supplied `iss` (RFC 9207) against discovery. When the authorization server lists `offline_access`, the section asks for it.
4. When the MCP server rejects an access token, the section uses its refresh token. Without one, the connection shows **Signed out**.
5. **Disconnect** ends the MCP session, and revokes the tokens when the authorization server names a revocation endpoint (RFC 7009).

When a server has no OAuth, choose **Token** and paste a bearer token.

Each connection has its own grant and MCP session, so you can open one server as several accounts. **Run as** sends the same call through other connections to the server and shows the results side by side.

### What the MCP client keeps

The server keeps MCP connections per caller. Tokens, refresh tokens, PKCE verifiers, and client registrations never reach the browser.

By default, connections live in server memory, and a restart ends them. To keep them, turn on the default [KV](/docs/kv) store with `kv: true` and set `VITEHUB_CONSOLE_MCP_KEY`. Generate the key with `openssl rand -base64 32`.

With the key, the server seals each connection and client registration with AES-GCM under `vitehub:console:mcp-client:`. Key names hold a hash of the owner, not their id or email. A key change makes old connections read as missing. Use a KV driver that all instances share, such as Cloudflare KV. Without the key, use the MCP client only in development or on one Node server.

> [!WARNING]
> Every MCP request starts on the server. A caller with the `mcp-client` section can make the server send requests to any URL. Give the section only to people you trust with the server's network.

Agents cannot use these connections.

## One-time links

Content preview and impersonation need your app's origin: the page renders the draft, or the app sets its own session cookie. The Console page runs on another origin, so it opens them with a one-time link:

1. The Console calls an operation with a signed request, such as `documents.preview` or `auth.impersonate`. The operation checks the section, the grant, and the target, as any operation does.
2. The operation returns `{ url, expiresAt }`. `url` is `GET /_vitehub/rpc?ticket=<ticket>` on your app.
3. The Console opens `url` in a new tab. Your app redeems the ticket once and answers with the page: the draft preview, or a redirect to the app home with the impersonation cookies.

A ticket is 32 random bytes. Your app keeps only its SHA-256, with the purpose, the app origin and mount, the person, the target, and the expiry. Redemption takes it out of the store first, so each ticket works once, also when two instances get it at the same time. A ticket works for 60 seconds. A used, expired, or changed ticket gets `401` with `CONSOLE_TICKET_INVALID`. A ticket that another app made, or that reaches a browser signed in to the app as another person, gets `403` with `CONSOLE_TICKET_MISMATCH`.

The store is the verification table of Better Auth, so the app needs [Auth with a Database](/docs/auth/configure#keep-users-in-the-app-database). A development server without one keeps tickets in memory. A production app without one refuses tickets with `500` and `CONSOLE_TICKET_STORE_MISSING`.

| Operation | Opens | The app checks at redemption |
| --- | --- | --- |
| `documents.preview` | The page of a document with its saved draft. | The person may read the document. The page renders the draft through the [preview frame](/docs/content/preview). |
| `auth.impersonate` | The app home as the user. | The browser's app session has the email of the person and Better Auth's `impersonate` permission. |
| `auth.stop-impersonating` | The app home as the administrator again. | The browser impersonates for the person. |

## Give browsers site access

The [tools pill](/docs/comments/configure#turn-comment-mode-on-and-off) on your app's pages, with Comments and the **Console** link, shows to people the app knows. With [Auth](/docs/auth), **Site access** in the Console signs browsers in to the app for you:

- **Open site** opens the app in a new tab, signed in as the app user with the email of your Console account. Site access makes that user when there is none.
- **Link a phone** shows a QR code. The phone's camera opens the link, and the phone is signed in as you. The code works for 10 minutes.
- **Invite someone** makes a link for a guest. You give them a name, which becomes the author of their comments, and pick what they can do, such as **Write comments**. The link works once, in one browser, for 1, 7, or 30 days. It signs the browser in as a new app user with that name. Guests never get the **Console** link, and the Console never lets them in.

Each link is a [one-time link](#one-time-links) with the `site.link` or `site.invite` operation. The people are Better Auth users, and each browser is a Better Auth session, so your app's session settings decide how long it lasts: Better Auth's default is 7 days, renewed once a day while the browser uses it. What they may do are roles of Better Auth's [`admin()` plugin](https://www.better-auth.com/docs/plugins/admin), in the comma-separated `user.role`, so Site access needs `admin()` in the `plugins` of `defineAuth()`:

- A member gets the `console` role, which shows the **Console** link, and the roles of every page tool.
- A guest gets the `guest` role and the roles you picked. Comments offers `comments-read`, `comments-write`, `comments-resolve`, and `comments-delete`, and [checks them](/docs/comments/configure#roles-from-site-access).

A guest user has no password and a placeholder email, `guest-<id>@guests.invalid`. Better Auth runs your `databaseHooks.user.create` for them, so a hook that closes sign-up refuses guests too.

**Revoke** next to a browser in **Site access**, or `site.revoke-session`, signs it out. A guest has one browser, so revoking it also deletes the guest. Their comments keep their name. A guest is an app user with a session, so routes of your app that let in any signed-in user let them in too: check the role there.

| Operation | Does |
| --- | --- |
| `site.link` | Returns a one-time link that signs the browser in as you, then opens `path`, or the app home. `qr: true` makes it last 10 minutes. |
| `site.invite` | Returns a one-time link that signs a guest in with `name` and the roles in `grants`. `expiresInDays` is 1, 7 (the default), or 30. |
| `site.invites` and `site.revoke-invite` | List the invites that nobody opened yet, and revoke one. |
| `site.sessions` and `site.revoke-session` | List the browsers of members and guests, and sign one out. |
| `site.grants` | Lists the roles that Site access gives. |

## Links to the Console

`hostedConsoleUrl()` from `vite-hub/runtime` builds a link to one page of a project in the Console. `consoleInvocationUrl()` and GitHub pull request comments use it. It encodes both values, and throws a `TypeError` for a project URL or a path that the Console refuses:

```ts
import { hostedConsoleUrl } from 'vite-hub/runtime'

hostedConsoleUrl('https://app.example.com', '/agents/support/invocations/abc')
// https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fagents%2Fsupport%2Finvocations%2Fabc
```

- `project` is the app origin, with its base path if it has one, such as `https://app.example.com/portal`.
- `path` is the page in the Console, such as `/kv` or `/agents/<agent>/invocations/<id>`. It must start with one `/`.

The Console opens that page of the app of your team whose URL is `project`. When your team has not linked the app, the link opens Home.

A self-hosted Console takes its origin as the third argument, such as `hostedConsoleUrl(url, '/kv', 'https://console.example.com')`.

### Open the Console from your pages

With `console` set, the [ViteHub tools pill](/docs/comments/configure#turn-comment-mode-on-and-off) on your app's pages has a **Console** segment. It is a link. It opens your app in [console.vitehub.dev](https://console.vitehub.dev) in a new tab, with `hostedConsoleUrl()`, the page origin, and the app base. When the page shows one Content document, through [`contentField()`](/docs/content/server-api#field-addresses) attributes, the link opens that document. Otherwise it opens the project overview. The app does not need Comments for this.

The link gives no access. The Console checks the person and the team when it opens the link, and opens Home when the team has not linked the app. The pill still keeps the link away from the app's other users:

| Where | Who sees **Console** |
| --- | --- |
| Development server | Every visitor. |
| Production, with [`console.authorize`](#limit-a-user-to-some-sections) | Visitors for whom `authorize` returns `true`, or `{ sections }` with one section or more. `authorize` gets `via: 'page'`, the session request of the page, and the app's Auth `user` when someone signed in. |
| Production, without `authorize` | App Auth users with the admin role of Better Auth's `admin()` plugin, or the `console` role that [Site access](#give-browsers-site-access) gives. [Give the first admin role](/docs/auth/configure#give-the-first-admin-role) with `VITEHUB_ADMINS` or a claim code. Without app Auth, nobody. |

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  // Show the Console link to every signed-in user of the app.
  if (context.via === 'page') return Boolean(context.user)
  // Every other caller keeps the access that it has without `authorize`.
  return true
})
```

An `authorize` that returns `true` for every context also shows the link to every visitor. Check `context.via` first.

The pill shows only when the page has a hint: `?vitehub` in the URL, the `vitehub-tools=1` cookie of an earlier visit, or a new app Auth session. On a development server without Auth, open a page with `?vitehub` once. A page on `http:` with a host that is not `localhost` or a loopback address, such as a LAN address, has no **Console** segment, because the Console cannot open that URL.

## Self-host the Console

The Console app is [`@vite-hub/console`](https://github.com/vite-hub/vitehub/tree/main/packages/console). It runs on Node.js with SQLite or on Cloudflare Workers with D1. Its README shows how to build, configure, and deploy it.

## Protect the Console route

The Console endpoint is `POST /_vitehub/rpc`. The skill files under `/_vitehub/.well-known/skills/` are public. ViteHub sends `X-Robots-Tag: noindex, nofollow` on these routes. This does not block access. Access comes from the signature:

| `console` | Who can call the endpoint |
| --- | --- |
| `true`, or an object without `auth` | Callers that [sign each request](#sign-console-requests) with a key whose public key is in a `VITEHUB_CONSOLE_KEY_<NAME>` variable: the ViteHub Console and the CLI. |
| `{ auth: false }` | Development only. Takes calls without a signature from this machine. A production build fails. |

> [!WARNING]
> A production build with `auth: false` fails with `VITE_HUB_B0022`, including when `authorize` is set. Remove `auth` and set a `VITEHUB_CONSOLE_KEY_<NAME>` variable. Development, CLI discovery, and `nuxi prepare` still accept `auth: false`.

When `console` is missing or `false`, a production build registers no Console route, and the host returns its normal not-found response. A development server without `console` serves only the Operations endpoint.

### Sign Console requests

The Console endpoint lets in only signed requests. Each caller has an Ed25519 key pair: the ViteHub Console has one for each linked app, and the CLI or a CI job has its own. The app keeps only the public keys, in `VITEHUB_CONSOLE_KEY_<NAME>` variables. A person or tool that reads the host env, or a pulled `.env` file, cannot sign a request. The build does not contain the keys.

To link an app in the [ViteHub Console](#in-production), set the line that its setup page shows. For the CLI, make a key pair:

```bash [Terminal]
pnpm vitehub secret console-key ci
# The app: set this variable on the deployment.
VITEHUB_CONSOLE_KEY_CI=<public key>
# The CLI: keep this one secret, such as in a CI secret. Remove the app variable to revoke it.
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key>
```

Set the first line on the server, such as `wrangler secret put VITEHUB_CONSOLE_KEY_CI` on Cloudflare. A key is 43 base64url characters, the raw 32 bytes of the Ed25519 public key. `<NAME>` has capital letters, digits, and underscores. The server reads the variables on each request.

Set the second line where the CLI runs. A command with `--url` signs each call with it:

```bash [Terminal]
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key> vitehub logs list --url https://app.example.com
```

The CLI reads one `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` variable, and `<NAME>` is the name that it signs with. Two of them is an error.

Each signed request has two headers:

- `x-vitehub-signature: key=<NAME>, t=<seconds>, origin=<app origin>, body=<SHA-256>, v1=<signature>`
- `x-vitehub-caller: <base64url JSON>`, who calls: `{"via":"cli"}`, or `{"via":"console","user":{...},"team":{...}}` from the Console.

The signature is Ed25519 over these lines, joined with a line feed:

```txt
vitehub-signature-v1
POST
/_vitehub/rpc
https://app.example.com
1794400000
CI
<SHA-256 of the exact body bytes, base64url>
<the x-vitehub-caller header>
```

The second line is the method, the third line is the path and query that the app receives, with an application mount such as `/portal/_vitehub/rpc`, and the fifth line is the time in seconds. The server checks the request in this order. Every refusal is `401` with a code and a fix:

| Code | Why |
| --- | --- |
| `CONSOLE_SIGNATURE_MISSING` | The request has no signature. A bearer token or a cookie does not count. |
| `CONSOLE_SIGNATURE_STALE` | The time is more than 5 minutes before or after the app clock. |
| `CONSOLE_SIGNATURE_ORIGIN` | The request was signed for another origin than this app. |
| `CONSOLE_KEY_UNKNOWN` | The app has no `VITEHUB_CONSOLE_KEY_<NAME>` for the name in the signature. |
| `CONSOLE_SIGNATURE_INVALID` | The signature does not match: another key, another path, another person, or a malformed header. |
| `CONSOLE_SIGNATURE_BODY` | The body is not the body that was signed. |

When no key variable is set, every request gets `500` with `CONSOLE_KEY_NOT_CONFIGURED`. When one of them is not a key, every request gets `500` with `CONSOLE_KEY_MALFORMED`, and the message names it. Signed requests reach only `POST /_vitehub/rpc`.

The app origin is the origin of `vitehub({ publicUrl })` when it is set. Node.js adapters build the request URL from `Host`, which the caller controls, so signed requests on Node require `publicUrl`. Without a matching configured origin, they fail with `500 CONSOLE_SIGNATURE_ORIGIN`. Use the string form for one deployment origin; the function form permits its configured Agent origins. Other hosts can use the request URL as routed by the platform. Forwarding headers never supply the app origin. The origin stops a request signed for one app, such as a preview, from working on another app with the same key. Inside the 5 minutes, the same request can run again on the same app. TLS keeps others from reading it.

A command without `--url` calls the dev server of its project and does not sign, so a dev server with `console: true` rejects the command. Pass `--url` with the origin of the dev server. On Node, also set `publicUrl` to that origin in the development configuration. The dev server also needs the public key in its environment:

```bash [Terminal]
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key> vitehub kv list --url http://localhost:3000
```

To use the commands without a key during development, set `auth: false` for the dev server only. The build keeps signed calls. A dev server without signed calls answers only requests from this machine.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: true,
    kv: true,
    host: 'node',
  },
  $development: {
    vitehub: { console: { auth: false } },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig(({ command }) => ({
  plugins: [vitehub({
    console: command === 'serve' ? { auth: false } : true,
    kv: true,
    host: 'node',
  }), nitro()],
}))
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  plugins: [vitehub({
    console: command === 'serve' ? { auth: false } : true,
    kv: true,
    host: 'node',
  })],
}))
```
:::
::

A signed caller gets every Console section. Set `console.authorize` to limit it. The context has `via: 'console'` with the `user` that the Console signed, the `team` that linked the app and the role of the user in it, or `via: 'cli'` with no `user`. Both have `key`, the `<NAME>` of the key. Operations get the same user as `context.user`. An Agent that calls Console operations as tools gets `via: 'agent'`, and the page tools pill gets `via: 'page'` when it asks whether to show the [Console link](#open-the-console-from-your-pages). Allow each one on its own:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  if (context.via === 'console') return context.user.email?.endsWith('@example.com') ?? false
  if (context.via === 'cli') return { sections: ['kv', 'logs:read'] }
  if (context.via === 'agent') return { sections: ['kv:read'] }
  return false
})
```

::warning
The holder of a private key decides which person it signs. Trust the person as much as the key. Keep private keys out of source code and client bundles.
::

### Give each caller its own key

Each caller has its own `VITEHUB_CONSOLE_KEY_<NAME>` variable, such as one for each Console link and one for the CLI in CI:

```bash [Terminal]
VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<console public key> \
VITEHUB_CONSOLE_KEY_CI=<ci public key> \
node .output/server/index.mjs
```

Hosts never give a secret back, so a command can add or remove its own variable without reading the others. Removing one variable revokes only that caller.

To rotate a key with no downtime, make a key pair with a new name, add its public key to the app, and deploy. Give the new private key to the caller, then remove the old variable and deploy again. The old key stops working at once.

### Move from auth: "app" or Console Auth

Earlier releases let the app sign people in to the Console with `console: { auth: 'app' }`, a Console Auth config (`auth: { ... }` with a server file, GitHub, or Cloudflare Access), or a bearer token with `auth: 'token'`. These options are removed, and so are `console.origins`, `console.mcp`, `console.signInPage`, and `console.embed`. A build that sets one of them fails with `VITE_HUB_B0020`, and the message names the fix. The app no longer serves `/_vitehub/mcp`, `/_vitehub/sign-in`, `/_vitehub/api/auth/**`, `/_vitehub/env/manage`, or OAuth discovery for the Console.

1. Remove `auth`, `origins`, `mcp`, and `signInPage` from the `console` options, or set `console: true`.
2. Move a check of the person to [`console.authorize`](#limit-a-user-to-some-sections). It gets the `user` that the Console signed, and the `team` and role of that user. App Auth access routes, such as `/_vitehub/**` or `/**`, no longer cover `POST /_vitehub/rpc` and `GET /_vitehub/rpc?ticket=`: a signed call has no app session, a one-time link has its ticket as proof, and the route checks its own access. A build fails when an app route file, such as `server/routes/_vitehub/rpc.post.ts`, uses the same path.
3. Remove `consoleMcpOAuth()` from `server/auth.ts`. Keep `mcpOAuth()` when the app serves its [own MCP server](/docs/mcp).
4. Link the app in [console.vitehub.dev](#in-production), and set the `VITEHUB_CONSOLE_KEY_<NAME>` line that it shows. Invite the people who used the app's Console to your team.
5. For the CLI, make a key with `vitehub secret console-key`, and replace `VITEHUB_CONSOLE_AUTHORIZATION`, `VITEHUB_CONSOLE_COOKIE`, and `CF_ACCESS_CLIENT_ID` with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`.
6. Connect agents to the [ViteHub MCP](/docs/development/mcp) of the Console instead of `/_vitehub/mcp`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { authorize: './server/console-authorize.ts' },
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
    console: { authorize: './server/console-authorize.ts' },
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
    console: { authorize: './server/console-authorize.ts' },
  })],
})
```
:::
::

The people who edit in the Console are Console accounts, not users of your app. To give editors only some sections, check the signed `user` in `authorize`:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

const editors = new Set(['editor@example.com'])

export default defineConsoleAuthorize((context) => {
  if (context.via !== 'console') return context.via === 'cli'
  if (context.team?.role === 'owner' || context.team?.role === 'admin') return true
  if (context.user.email && editors.has(context.user.email)) return { sections: ['content', 'comments', 'blob:media'] }
  return false
})
```

Live Content editing, the Content page preview, Env management, and the Connections connect flow needed the app session, and are not in the Console.

### Limit a user to some sections

Every Console call runs `authorize` with the Web `Request` before it reads data: operations, invocation actions, Channel replay, and Schedule runs. A `Response` from `authorize` goes out as it is. `authorize` returns one of these values:

| Result | Effect |
| --- | --- |
| `true` | Allows every Console section. |
| `{ sections: ['content'] }` | Allows only these section ids, with all their actions. An empty list returns `403`. |
| `{ sections: ['kv:read'] }` | Allows `kv` for reads only. `write` and `destructive` operations return `403`, unless the call only reads (`readOnlyWhen`). |
| `{ sections: ['blob:media'] }` | Allows Blob operations on the `media` store only. `'blob:media:read'` allows only reads. |
| `false` | Returns `403`. |
| A `Response` | Returns that response, for example a `401`. |

Any other value returns `500`. The context of a call from the Console has the `user` that the Console signed:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  if (context.via !== 'console') return false
  if (context.team?.role === 'owner') return true
  return { sections: ['content'] }
})
```

A section entry is the section id, or `'<section>:read'` for read only. A read grant allows only `kind: 'read'` operations and calls that `readOnlyWhen` marks as reads, on every surface (Console RPC, `vitehub <namespace> --url`, and agent tools). Schedule runs refuse it, and so do write operations such as `channels.replay`, `agents.invoke`, and `media.upload`. With `'kv:read'` and `'kv'` together, the full grant wins. The Console hides write actions for a read grant.

#### Grant one Blob store

`'blob'` allows the Blob operations (`blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.delete`, `blob.media`, and `blob.variants`) on every store. `'blob:<store>'` allows them on one store, and `'blob:<store>:read'` only the reads. A store grant gives editors the public Media store without the private Content store:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize((context) => {
  if (context.via !== 'console') return false
  if (context.team?.role === 'owner') return true
  // `media` is the served store. The `default` store keeps the Content workspace.
  return { sections: ['content', 'comments', 'blob:media'] }
})
```

The server checks the store of each call on every surface. A call without `store` uses `default`. A call to another store returns `403` with `CONSOLE_ACCESS_DENIED`, and the message names the needed grant, such as `'blob:default'`. `blob.list` returns only allowed stores in `stores`. A store grant does not open the Blob section, which needs `'blob'` or `'blob:read'`, so editors use the [Media library](/docs/content/console#media-library) of Content. A store named `read`, or with `:` in its name, needs the whole `'blob'` grant.

::warning
Breaking change: a section grant now includes its write actions. `{ sections: ['kv'] }` lets a user set and delete keys, `'blob'` lets them upload and delete blobs, and `'rate-limits'` lets them reset counters. For a read-only role, use `'<section>:read'`, such as `{ sections: ['kv:read', 'blob:read'] }`.
::

Section ids are the ids in the Console URL, such as `env`, `agents`, `usage`, `content`, `blob`, `databases`, `kv`, `workspaces`, `workflows`, `queues`, and `schedules`. Each route and operation declares its section, and the server returns `403` for a section outside the list. Write actions need the section that owns them:

- Agent Invocations and Channel replay: `agents`. Schedule runs: `schedules`.
- Workflow starts, cancels, and resumes: `workflows`.
- Content saves and publishes: `content`. Content then checks `content.can()`, so `defineContent({ authorize })` decides which collections and actions an editor gets.

The Console shows only allowed sections, but the server check is the security boundary.

### How each mode checks a request

The Console route checks access itself.

| Configuration | Check |
| --- | --- |
| `console: true` | Verifies the [Ed25519 signature](#sign-console-requests) with the `VITEHUB_CONSOLE_KEY_<NAME>` that it names. Returns `401`, or `500` when no key is set or one is malformed. A cookie, a session, or a bearer token never counts. |
| `auth: false` | Allows development calls from this machine. A production build fails with `VITE_HUB_B0022`. |
| `authorize` | Runs after either check. It can reject the request or limit it to some sections. |

All Console paths sit under the application base: an explicit ViteHub application base (set from Nuxt `app.baseURL`), else a root-relative Vite `base`. With `base: '/portal/'`, the route is `/portal/_vitehub/rpc`, and you link the app in the Console as `https://app.example.com/portal`.

### Share a development server

A development server without signed calls trusts whoever can reach it, so the endpoint answers only this machine. A tunnel or a reverse proxy on this machine, such as `cloudflared`, `ngrok`, `tailscale serve`, an `ssh -R` tunnel, or Caddy, connects to the dev server from `127.0.0.1` too. To share a dev server through one, remove `console.auth` so the server takes only signed calls.

A request with a `Host` other than `localhost`, a `.localhost` name, `127.0.0.1`, or `[::1]`, a peer address that is not loopback, or a forwarding header gets `403` with `CONSOLE_LOOPBACK_ONLY`. The forwarding headers are `Forwarded`, `Via`, any `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, `CDN-Loop`, any `CF-*`, `Fly-Client-IP`, `Fastly-Client-IP`, `X-Vercel-Forwarded-For`, any `Ngrok-*`, and any `Tailscale-*`. The `vitehub` CLI on this machine passes this check.

A forwarder that copies raw TCP bytes, such as `ssh -R` or `tailscale serve --tcp`, adds no header, so ViteHub cannot tell its requests from yours. Only signed calls protect a dev server behind one.

When the endpoint takes calls without a signature, the dev server prints a note at startup. A server that listens on more than loopback, for example with `--host`, prints it as a warning.

### Start Agent Invocations

`invoke` lets the Console start Agent Invocations and run manual Schedules. It is `true` on the development server and `false` in a production build by default:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    console: { authorize: './server/console-authorize.ts', invoke: true },
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
  plugins: [
    vitehub({
      console: { authorize: './server/console-authorize.ts', invoke: true },
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
      console: { authorize: './server/console-authorize.ts', invoke: true },
    }),
  ],
})
```
:::
::

The invocation operations call `authorize`, so it decides who can start invocations. A user also needs the `agents` section. `invoke: false` keeps inspection and turns off new invocations. Fixture mode always turns them off.

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

History must hold valid ViteHub Messages with `user` or `assistant` roles, unique IDs, and `text`, `file`, `image`, or `audio` parts. The Console adds the prompt as a user Message. It rejects bad Messages, `system` or `tool` roles, and other parts before the Agent starts. Each request creates a new invocation and does not resume an earlier runtime session.

### Cancel a running session

A session in which an Agent changed a person's page through the [page Capability](/docs/agents/capabilities/page) has a **Page** surface: each change with its label, the values before and after, the step, the page, the person, and the time. **Undo** asks the person's open page to put one change back, through `invocations.undo`. It needs write access to the Agents section, works only while the page is open, and keeps a value the person changed after the Agent.

A pending or running session shows **Cancel session** in its header when the Console has `invoke` access for its Agent. Without it, the button is hidden and `invocations.cancel` returns 403.

The Console calls `invocations.cancel(id)` on the Agent's journal. A run in the same process stops at once. A run in another process sees the request at its next claim renewal, within 10 seconds. When the Driver (the code that runs the Agent) cannot stop the run, the header shows `Cancel requested, not enforced by <driver>`, and the session runs until the Driver returns. See [Cancel an invocation](/docs/agents/invocations#cancel-an-invocation) for each Driver.

A finished session shows **Abort stale execution**. It sends an abort signal to any execution still registered in the server process, without changing the journal. A journal that did not keep a pending or running request returns 503.

### Keep Console routes out of search engines

Nuxt needs no SEO module for the `X-Robots-Tag` default. If the app uses `@nuxtjs/robots` or `@nuxtjs/seo`, add route rules so its robots and sitemap modules skip the Console routes:

```ts [nuxt.config.ts] fragment
// With @nuxtjs/robots or @nuxtjs/seo in `modules`
routeRules: {
  '/_vitehub': { robots: false },
  '/_vitehub/**': { robots: false },
},
```

Do not use `robots.txt` as access control. Crawlers can ignore it, and a blocked URL can still be listed. Read [Auth](/docs/auth/server-api#authorize-access-routes) for the full callback contract.

## Know what the Console stores

The Console does not store Agent Invocations. It reads the app-wide journal that `@vite-hub/agent` installs, with the Console on or off. When Agents are configured and no journal is set, that is the default journal at `.vitehub/data/agent-invocations.sqlite`. It retains invocation records and selected searchable text, including prompts, messages, final text, progress updates, and generated session titles. See [the default journal](/docs/agents/invocation-storage#use-the-default-journal) for its options, location, and retention.

Earlier releases stored this journal at `.vitehub/data/console.sqlite` and read `console.databaseUrl`, `console.observations`, `console.retention`, and `VITEHUB_CONSOLE_DATABASE_URL`. These options are removed. A build that sets one of them fails with `VITE_HUB_B0020`, and a server that sets `VITEHUB_CONSOLE_DATABASE_URL` fails with `AGENT_R1032`. Set `agent: { invocations: { databaseUrl, observations, retention } }` and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` instead. To keep old records, set `databaseUrl` to the old file, or pass it to [`vitehub agent invocations`](/docs/agents/invocation-storage#inspect-and-maintain-from-the-cli) with `--database`.

Console image uploads use the configured Blob store. Before each new upload, the Console retries at most 100 pending rollback records. Malformed batch records move unchanged to `_vitehub/console/quarantine/batch/<id>`. New uploads continue, but stored attachment references stay unavailable while any quarantine record exists, because their delete owner is unknown. Quarantine deletes no image bytes.

To repair a quarantined record:

1. Get its original attachment UUIDs from trusted storage history.
2. Write their JSON array (1–10 UUIDs) to `_vitehub/console/cleanup/batch/<id>` for new quarantines, or `vitehub-console-attachment-cleanup/<id>` for legacy ones.
3. After a later upload drains that cleanup record, delete the quarantine object through the Blob provider.

If you cannot get the original UUIDs, keep the quarantine record. Guessing can delete kept images.

In production, the operator must still decide how long to keep records that may contain sensitive data. Workflow, Queue, and Schedule inspection do not use the journal. Workflow and Queue do not show run or message history, because ViteHub does not yet have provider-independent contracts for that data. Use [`vitehub schedule`](/docs/development/cli#run-and-inspect-schedules) to run Schedules or list recorded runs, in development or on a deployment with `--url`.

A journal from `defineAgent({ invocations })` or from the app-wide `agent.invocations` option replaces the default journal. The Console reads that journal instead. An Agent with `invocations: false` records no sessions. With `agent: { invocations: false }`, the Console lists no sessions. Configure the same journal on every discovered Agent, or set [`agent.invocations`](/docs/agents/invocation-storage#use-one-journal-for-every-agent). Distinct journals fail during runtime setup because the Console reads one combined journal.

Every read goes through the RPC route. A KV value read uses a JSON-body `POST`, so the key stays out of the URL. Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

KV inspection calls the store's paginated `list`, `get`, and `has`. Each key page has at most 200 entries. Values show as text or formatted JSON, cut at 256 KiB. Listing and reading can still count as provider operations.

Blob inspection calls only the store's `list`, with an optional pathname prefix. It returns at most 100 objects first and 250 per request. ViteHub keeps its own objects, such as Workspace history and Console attachments, under `_vitehub/` and hides them, so a page can have fewer objects than its limit. **Show ViteHub files** lists them. Object contents and provider URLs never reach the Console.

## Inspect the Agent context

Open an Agent Invocation and expand **Captured setup** to see that run's context: the final instruction blocks and the tools the model sees, with each tool's description and input and output JSON Schemas. It is the result after the Agent Definition, Capabilities (features you add to an Agent), and runtime tools apply, so it covers dynamic tools too.

Invocation journals keep metadata only by default. Then Captured setup has tool names but no instructions, descriptions, or schemas. Set `configuration: 'content'` on the Agent's journal to keep the context apart from other trace content. `content: 'content'` also keeps it. Large observations stay inside ViteHub's trace limits and are marked when cut.

> [!WARNING]
> This context can contain secrets or customer data from app code. Protect it like prompts and model output, with the same access, retention, and encryption controls. See [Agent Invocations](/docs/agents/invocation-storage#store-invocation-history).

## Inspect Skills

Open **Skills** to browse the files bundled with each Agent Definition: colocated `skills/` files and Skills added with `agentWithSkills()`. Select a file to read its Markdown preview or source. Links to other bundled files open them in the tree.

**Skill index** opens [ViteHub's published Skill index](https://vitehub.dev/.well-known/skills/index.json), which is not your app's Skills. The skills that your app serves to coding agents are in **Served skills**.

This view reads the current Agent Definition. It does not start an invocation or refresh a Source. Text previews stop at 512 KiB. Binary files are listed without a preview.

## Inspect usage

Open **Usage** to see the tokens and cost that providers report for the past 24 hours, 7 days, 30 days, or 90 days. It groups completed Agent Invocations by time and model. A warning shows when the scan reaches 10,000 records or a finish event is cut, so partial totals never look complete. The `usage.get` operation returns the same data.

Session details show the usage record of one invocation. Add the [Usage Capability](/docs/agents/capabilities/usage) when the provider needs an explicit usage request, estimated cost, or a typed Agent Usage Record at finish.

The Console does not fill in missing provider data. Token counts, model metadata, and cost stay empty when the provider does not report them.

## Inspect capabilities

Open the right panel's tab chooser and select **Capabilities**. Select a Capability to see its recorded data and tools. MCP groups tools by server with their original names and schemas. Title shows its settings, progress, and result. Other Capabilities get a default tools and configuration view.

The panel reads the Invocation's snapshots. It does not run MCP discovery or title generation. Missing or cut data is marked. You can [add a read-only view](/docs/agents/capabilities/custom#contribute-an-inspection-view) with the shared JSON Render component catalog.

## Inspect logs

[Logs](/docs/logs) uses Evlog for request capture, structured fields, redaction, sampling, and drains. Explorer and Stream show the selected event in the right inspector. The `logs.list` operation returns the same data, and the CLI reads it with `pnpm vitehub logs list --level error --json`.

## Fix common failures

| Symptom | Check |
| --- | --- |
| A section is absent from the Console | Configure its primitive, such as `agent`, `kv`, `blob`, `database`, `rateLimit`, `workspace`, or `sandboxTask`. The Console lists only primitives active in the same ViteHub configuration. |
| A KV key page stops at 200 entries | Load the next page or enter a key prefix to narrow the list. |
| KV or Blob inspection returns a provider error | Check that the deployed app has permission and credentials to read the configured store. |
| Agents opens but has no sessions | Invoke a discovered Agent. Confirm it uses the default journal or the app-wide `agent.invocations` journal. |
| Agent Console startup fails on a deployment host | Set `agent.invocations: 'database'`, or give every Agent Definition one durable journal. The default SQLite journal needs a writable, persistent filesystem. |
| The Console cannot reach a deployed app | Link the app with the URL that serves it, and check that the server is public. The Console cannot reach a `vite dev` server on your machine. |
| The build fails with `VITE_HUB_B0020` and names a `console` option | The option is removed. Follow the fix in the message, or see [Move from auth: "app" or Console Auth](#move-from-auth-app-or-console-auth). |
| `console.impersonation` fails with `VITE_HUB_B0005` | Set `auth: true` and add an Auth Definition with Better Auth's `admin` plugin, such as `server/auth.ts`. |
| The server warns that `auth: false` takes calls without a signature | Remove `console.auth`, and set a `VITEHUB_CONSOLE_KEY_<NAME>` variable. |
| Console routes return `500` with "console.authorize must return" | Return `true`, `false`, a `Response`, or `{ sections: string[] }` from `authorize`. Use the global `Response`. |
| A call returns `401` | Sign the request. See the code in [Console error codes](#console-error-codes). |
| A call returns `403` | `authorize` rejected this caller, or returned `{ sections }` without that section id. |

### Console error codes

A `401` for a missing or wrong signature carries `WWW-Authenticate: VitehubSignature realm="vitehub-console"`.

Each failed Console request returns JSON with a stable `code`, a `message` that says why, a `fix`, and a `docs` link. RPC failures also keep `ok: false` and `status`.

| Code | Status | Fix |
| --- | --- | --- |
| `CONSOLE_ACCESS_DENIED` | `403` | Use an account or a key that `authorize` allows. |
| `CONSOLE_IMPERSONATING` | `403` | This caller uses an impersonation session. Stop impersonating to get your own session back. |
| `CONSOLE_DEVELOPMENT_ONLY` | `403` | Rebuild and deploy with a `console` option. Set `console.authorize` to restrict who may use it. |
| `CONSOLE_LOOPBACK_ONLY` | `403` | The development server takes calls without a signature and answers only this machine. See [Share a development server](#share-a-development-server). |
| `CONSOLE_ORIGIN_REJECTED` | `403` | A call without a signature must come from the app origin, or send `x-vitehub-console: 1` with no `Origin`. Browsers cannot call the endpoint from another origin. |
| `CONSOLE_SIGNATURE_MISSING` | `401` | Open the app from the ViteHub Console, or set `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` for the CLI. See [Sign Console requests](#sign-console-requests). |
| `CONSOLE_SIGNATURE_STALE` | `401` | Sync the clock of the machine that signs. |
| `CONSOLE_SIGNATURE_ORIGIN` | `401` | Link the app with the URL that serves it. Behind a proxy that ends TLS, set `vitehub({ publicUrl })`. |
| `CONSOLE_SIGNATURE_INVALID` | `401` | Use the private key whose public key is in the `VITEHUB_CONSOLE_KEY_<NAME>` that the signature names. |
| `CONSOLE_SIGNATURE_BODY` | `401` | Send the body that the signature covers. A proxy must not change it. |
| `CONSOLE_TICKET_INVALID` | `401` | Open the page again from the Console. A [one-time link](#one-time-links) works once, within 60 seconds. |
| `CONSOLE_TICKET_MISMATCH` | `403` | Open the link in the browser where you are signed in to the app with the email of your Console account. |
| `CONSOLE_TICKET_STORE_MISSING` | `500` | Add app Auth with a Database, so every instance shares the tickets. |
| `CONSOLE_KEY_UNKNOWN` | `401` | Set the `VITEHUB_CONSOLE_KEY_<NAME>` line from the Console setup page or `vitehub secret console-key`, then restart or deploy. |
| `CONSOLE_KEY_NOT_CONFIGURED` | `500` | Set a `VITEHUB_CONSOLE_KEY_<NAME>` variable, then restart or deploy. |
| `CONSOLE_KEY_MALFORMED` | `500` | Set the 43 base64url characters of the public key, with no quotes or spaces, then restart or deploy. |
| `CONSOLE_ACCESS_NOT_CONFIGURED` | `500` | Build the app with the ViteHub plugin. |
| `CONSOLE_AUTHORIZE_REQUIRED` | `500` | Set `console.authorize`. |
| `CONSOLE_REQUEST_INVALID` | `400`, `405`, `413` | Check the request body. Update `vite-hub` in the app when the Console is newer. |
| `CONSOLE_NOT_FOUND` | `404` | Reload the Console. |
| `CONSOLE_CONFLICT` | `409` | Reload, then try again. |
| `CONSOLE_UNAVAILABLE` | `408`, `429`, `502`–`504` | Wait, then try again. |
| `CONSOLE_REQUEST_FAILED` | `500` | Try again, then read the server logs. |
| `CONSOLE_MCP_UNREACHABLE` | `502` | Check that the MCP server runs and that the URL is its Streamable HTTP endpoint, such as `/mcp`. |
| `CONSOLE_MCP_SIGNED_OUT` | `409` | Sign in again. For a token, connect again with a new one. |
| `CONSOLE_MCP_AUTHORIZATION_FAILED` | `400`, `404`, `409`, `502` | Start the sign-in again. The server must publish RFC 9728 metadata that names an authorization server with client registration. |
| `CONSOLE_MCP_KEY_INVALID` | `500` | Set `VITEHUB_CONSOLE_MCP_KEY` to 32 random bytes as base64 or hex, such as the output of `openssl rand -base64 32`. |
| `CONSOLE_MCP_KV_REQUIRED` | `500` | Turn on the default KV store with `kv: true` or an explicit default KV configuration, then rebuild. |

A route that fails with its own diagnostic keeps that code, such as `VITE_HUB_R0114`.

See [Agent Invocations](/docs/agents/invocations) for custom stores and the invocation lifecycle. To build your own inspection page, use [AI components](/docs/ui/ai-components) such as [Trace](/docs/ui/trace) and [Code block](/docs/ui/code-block).

### Image upload boundaries

Image uploads need `console.invoke`. The Agent and invoker profile you chose at submit stay fixed while images upload. If you switch Agents, the pending request stays with the first Agent.

- Images must be PNG, JPEG, WebP, or GIF: at most ten images and 10 MiB in total per invocation.
- Blob storage must return an HTTP or relative serving URL.
- If storage or setup fails before the Agent takes the images, the Console rolls back the uploads.
- Images given to an Agent stay under `_vitehub/console/attachments/` and follow your Blob retention policy.
