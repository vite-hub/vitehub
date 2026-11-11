---
title: Console
description: Open your app in the hosted Console, and protect the endpoint that it calls.
navigation.order: 32
navigation.group: Local tools
icon: i-lucide-monitor-dot
---

The ViteHub Console is a web app at [console.vitehub.dev](https://console.vitehub.dev). It shows the primitives that your app turned on, and it can open many apps. Your app does not serve a Console page. It serves an endpoint that the Console, the `vitehub` CLI, and agents call:

| Route | Use |
| --- | --- |
| `POST /_vitehub/rpc` | The Operations endpoint. Each request carries one [birpc](https://github.com/antfu-collective/birpc) call, as the next section shows. An [operation](/docs/development/operations) is a named action, such as `invocations.list` or `content.publish`. |
| `/_vitehub/mcp` | The [MCP endpoint](/docs/development/mcp) for agents. |
| `/_vitehub/.well-known/skills/` | The [ViteHub skill](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-your-app) for `npx skills add`. |

### Call format

Each `POST /_vitehub/rpc` request carries one birpc request message as JSON. `m` is the operation name, `a` holds its input, and `i` is an id that the reply repeats:

```json [Request]
{ "m": "sections.list", "a": [{}], "t": "q", "i": "V1StGXR8_Z5jdHi6B-myT" }
```

The response carries one reply. `r` holds the value. The HTTP status is `200`, or the status that the operation sets, such as `202`:

```json [Response]
{ "t": "s", "i": "V1StGXR8_Z5jdHi6B-myT", "r": { "sections": ["agents", "kv"] } }
```

A failure has `e` instead of `r`, with the diagnostic `code`, `message`, and `status`, and `fix`, `docs`, or `details` when the failure has them. The HTTP status is the same `status`. A failure never contains a stack. A request that the endpoint cannot read, such as a body over the limit, gets a reply without `i`. Only own operation names run: `toString`, `constructor`, `__proto__`, and other unknown names get `404` with `Console operation not found.`

The sections are Auth, Env, Connections, Agents, Channels, Usage, MCP client, Logs, Content, Comments, Blob, Databases, Email, KV, Rate Limits, Sandbox Tasks, Workspaces, Workflows, Queues, and Schedules. The Console shows only the sections that the app installs and that [`authorize`](#limit-a-user-to-some-sections) allows.

- **Channels** lists the Channels of your Agents, their threads, and each conversation with its attachments and the runs that answered. You can download a conversation as Markdown or JSON. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).
- **Content** shows when `server/content.ts` defines document collections. It saves drafts, publishes, and restores revisions. `content.can()` decides what each user may do. See [Edit Content in the Console](/docs/content/console).
- **Comments** shows when the app turns on [Comments](/docs/comments/configure#turn-comments-on-in-a-vitehub-app). It lists the threads that people left on the app's pages.
- **Blob** lists stores and pages of object metadata. It uploads (up to 8 MiB) and deletes objects with `blob.put` and `blob.del`.
- **Database** lists found Definitions (the files that declare each resource), their source, definition mode, and table names, without connecting to a database.
- **KV** lists stores and keys. It fetches a value only when you select its key. It edits and deletes with `kv.set` and `kv.del`.
- **Rate Limit** lists policies. It reads or resets the counter of a key you enter with `rate-limit.peek` and `rate-limit.reset`.
- **Sandbox**, **Workspace**, **Workflow**, and **Queue** list Definitions and their source without starting runtime resources.
- **Schedule** lists Schedule Definitions with their cron expression and time zone. It runs a Definition that sets `manual: true`.

> [!WARNING]
> Console data can contain user prompts, model output, tool activity, Blob metadata, provider metadata, and stored KV values. Protect the endpoint before you put the app on a production URL.

## Open your app in the Console

### In development

A static Console build can connect to a development server directly. The account Console forwards requests from its server, so it needs a deployed app that the server can reach. Without a `console` option, `vite dev` serves the Operations endpoint, and accepts calls from the origins in [`console.origins`](#call-the-console-from-another-origin) without a token. The default is `https://console.vitehub.dev`. `console: { auth: false }` works the same way.

At startup, the development server prints a link that opens the app in the hosted Console:

```txt
https://console.vitehub.dev/open?project=http%3A%2F%2Flocalhost%3A3000
```

Open it, and select **Continue** to link the project. Chrome asks for permission to reach the local network. The development server answers only this machine. See [Share a development server](#share-a-development-server).

### In production

[console.vitehub.dev](https://console.vitehub.dev) is the Console as its own app, [`@vite-hub/console`](https://github.com/vite-hub/vitehub/tree/main/packages/console). Sign in with GitHub or a passkey. Each account has a personal team, and you can make more teams and invite people. A team's projects open in any browser where a member signs in. The sidebar lists the team's apps, **Members** to invite people and remove them, and **Settings** for your name, GitHub sign-in, and passkeys. Invitations are links that you send yourself. The Console sends no email.

The Console server keeps an Ed25519 key pair for each linked project, with the private key encrypted, and [signs](#sign-console-requests) each call to the project's Console endpoint with it. The signature names the person who calls. The app keeps only the public key, and the browser never sees the private key.

To open a deployed app there:

1. Set `console: { auth: "token" }` and deploy.
2. Open [console.vitehub.dev](https://console.vitehub.dev) and sign in. **Get started** asks for the app URL. Later, select **+** next to **Apps** in the sidebar.
3. The Console shows a variable and its value, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>`. Set it on the server, deploy, and select **Check connection**.

Each link has its own variable, so the app can keep other keys next to it, such as the key of the CLI. To unlink a project, unlink it in the Console and remove its variable from the app.

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

The other `auth` choices protect the endpoint for the CLI, MCP clients, and agents. See [Protect the Console route](#protect-the-console-route).

The Console does not turn on [Comments](/docs/comments). Add `server/comments.ts` or set `comments: true` to get the **Comments** section.

## Read the project

The `project.get` operation tells a client what the project runs and what the caller may use. Each section and each operation is one that the app installs and that [`authorize`](#limit-a-user-to-some-sections) allows for the caller. A read-only grant, such as `"kv:read"`, and an MCP access token without `vitehub:write` leave out the operations that change state. Every caller that passes Console access can read it.

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

`protocol` is the version of this answer. A client stops when the protocol is one that it does not know. `vitehub` is the version of the `vite-hub` package that the app runs. An operation that reads its section from the input, such as `documents.action`, is in the list, and each call checks its section again.

## Inspect environment declarations

Env searches declared Server Env variables and filters them by source. A variable shows its provider, secret flag, and whether it is required or has a default.

Env does not read secret values, call providers, or check credentials. Values and defaults stay hidden. Env management (values, Access, and Activity) needed the Console that the app served, which is removed. Change host values in your deployment configuration. Set `env: false` in the ViteHub options to turn off Env and its section.

## Manage Connections

Connections shows each [Connection](/docs/connections) (a stored login to an outside service) from `server/connections/`, with its status, type (**OAuth** or **API key**), account, scopes, and last error. A production build has the section only with `connections: { management: true }`.

The connect flow (**Connect**, **Set key**, **Refresh token**, and **Disconnect**) needed the Console that the app served, which is removed.

## Connect to MCP servers

Set `console.mcpClient` to `true` to add the MCP client section. It runs on the server and connects to MCP servers over Streamable HTTP as the Console caller. It lists and calls their tools, reads their resources, gets their prompts, and shows each result as the server sent it.

```ts
import { vitehub } from 'vite-hub'

vitehub({
  console: { auth: 'token', mcpClient: true },
})
```

The section uses the MCP SDK. Install it in your app first:

```sh
pnpm add @modelcontextprotocol/sdk
```

This section is the client side. [ViteHub MCP](/docs/development/mcp) at `/_vitehub/mcp` is the server side, and needs no option.

The section lists ViteHub MCP and the MCP server that the app announces in its [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata at `/.well-known/oauth-protected-resource`, such as its own `/mcp`. **Connect** also takes the URL of another server. URLs must use HTTPS. Plain HTTP works only for this app and `localhost`. The same rule applies to OAuth endpoints and every redirect.

### Open ViteHub MCP

ViteHub MCP needs no sign-in. Each request carries the credentials of the Console request that started it: the `Authorization` header, the session cookie, or the Cloudflare Access token. The server stores none of them and sends them only to `/_vitehub/mcp` on the same origin and mount. ViteHub MCP lists the tools of your Console sections.

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

Agents and ViteHub MCP cannot use these connections.

## Hosted Console

> [!WARNING]
> The static Console build in this section sends bearer tokens from the browser. Apps with `auth: 'token'` take only [signed requests](#sign-console-requests), and a browser cannot sign them, so the static build and its **Start a new project** link cannot open those apps. Use [console.vitehub.dev](#in-production), which signs each call on its server.

The static build has no server and keeps no state. The project list and the tokens stay in your browser, and the browser calls each project directly.

The page sends a strict Content Security Policy. It loads scripts only from its own origin and cannot be shown in a frame. The browser lets it call `https:` origins, and `http://localhost` and `http://127.0.0.1` on any port.

The hosted Console does not have Content live editing, the Content page preview, the Connections connect flow, Env management, or Blob image previews that need the app session. These needed the Console that the app served, which is removed.

### Link a project

::note
These steps are for a static Console build that you host yourself, which keeps projects in the browser. [console.vitehub.dev](https://console.vitehub.dev) uses accounts instead. See [Hosted Console](#hosted-console).
::

1. Select **Link project**.
2. Enter the app URL: its origin, with its base path if it has one, such as `https://app.example.com` or `https://app.example.com/portal`.
3. The Console reads [`project.get`](#read-the-project). When the project asks for a token, paste the token that you created for it and select **Sign in**.

The Console then shows the sections that the project lists for this token. When linking fails, the Console says why:

| Message | Fix |
| --- | --- |
| `<console> is not in console.origins for <host>` | Add the Console origin to `console.origins`, then build and deploy again. In production, the project must use `auth: "token"`. The browser hides why a cross-origin request failed, so the project can also be offline. |
| `<host> refused this token` | Paste the token again, or ask the owner of the app for a new one. |
| `<host> takes signed requests only` | The app uses `auth: 'token'`. Open it from [console.vitehub.dev](#in-production). |
| `This project runs vite-hub <version>. This Console needs protocol 1.` | Update `vite-hub` in the app. |

### Start a new project

::note
These steps are for a static Console build that you host yourself, which keeps projects in the browser. [console.vitehub.dev](https://console.vitehub.dev) uses accounts instead. See [Hosted Console](#hosted-console).
::

The hosted Console can start a new app for you. It needs a `vite-hub` release with `vite-hub init` ([#3523](https://github.com/vite-hub/vitehub/pull/3523)), which is not released yet.

1. Select **New project** on the empty Console, in the project menu, or in <kbd>⌘</kbd><kbd>K</kbd>. The page is at `/new`.
2. Enter the folder name and pick the host. Features that the host cannot run are greyed out and say why.
3. Pick the features. The page adds the features that they turn on, such as Database for Comments, and marks them **Added by**. When the host needs an option for a feature, such as `email.driver` on Vercel, the page asks for it. Console is always on and uses token auth.
4. Once the stack has no problems, copy the command and run it in your terminal:

```bash [Terminal]
pnpm dlx vite-hub init my-app --host cloudflare --features console,kv,queue --option console.auth=token --console <id>:sha256:<verifier> --yes
```

5. On Cloudflare, Vercel, Netlify, or Deno, open the app folder and run `pnpm vitehub deploy`. This sets up the Console key on the host and prints a link. Open that link in the same browser. For Node.js, deploy the app with `VITEHUB_CONSOLE_TOKEN_SHA256` set to the verifier from `--console`. Then open `https://console.vitehub.dev/link#p=<id>&url=<app-origin>` in the same browser, with `<id>` from `--console` and the URL-encoded origin of the deployed app. See [Link a new project](#link-a-new-project).

The address of the page holds the stack: the folder, the host, the features, and non-private options, such as `/new?host=vercel&features=email&option=email.driver%3Dresend`. Database connection URLs can contain credentials, so they stay only in page memory and the generated command. The `--console` value is not in the address, because its link works only in the browser that made it.

Creating a command needs persistent browser storage and Web Locks. Allow browser storage and use a current browser.

### Link a new project

::note
These steps are for a static Console build that you host yourself, which keeps projects in the browser. [console.vitehub.dev](https://console.vitehub.dev) uses accounts instead. See [Hosted Console](#hosted-console).
::

A one-time link lets a new project link itself, so you do not copy a token by hand. [Start a new project](#start-a-new-project) makes the link and prints it in the `vite-hub init --console` command. That command is not released yet. Until then, use [Link a project](#link-a-project) with the app URL and its token.

The hosted Console makes a random key and keeps it in this browser, in `localStorage` under `vitehub-console:pending-links`. It gives out only an id and the SHA-256 of the key. The setup command stores that hash in the app as `VITEHUB_CONSOLE_TOKEN_SHA256` and prints a link such as `https://console.vitehub.dev/link#p=<id>&url=<app origin>`. The link holds no secret.

When you open the link, the Console removes it from the address bar and asks **Link `<host>`?**. It sends nothing before you confirm. Select **Link project** only when the host is the app that you just started, because a changed link can name another host. The Console then sends the key to that app, saves the project with the key as its Console token, and deletes the one-time entry.

The link has limits:

- It works only in the browser profile that made it. Teammates link the project with their own token.
- It works once, and for 24 hours. A used or unknown link says `This link was made in another browser or already used`. Make a new link and run the command again.
- When the app refuses the key, its `VITEHUB_CONSOLE_TOKEN_SHA256` is not the hash of this link. Run the command again, or relink.
- The first confirmation binds the link to that app URL, also when the request fails. Another app needs a new link.
- Only one tab can use a link, with [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). A browser without Web Locks, or a Console on plain `http:` outside `localhost`, cannot confirm a link.

### Switch projects

The top of the rail shows the name and the host of the open project. Select it, or press <kbd>⌘</kbd><kbd>K</kbd> and choose **Switch project**, to see the linked projects. A dot shows if each one is reachable, needs a new token, or is unreachable. The Console opens the project that you choose, and opens it again after a reload.

### Links to the hosted Console

A link can open one page of a project in the hosted Console:

```txt
https://console.vitehub.dev/open?project=<app URL>&path=<Console path>
```

- `project` is the app origin, with its base path if it has one, such as `https://app.example.com/portal`. It must be `https://`, or `http://` on `localhost`, `127.0.0.1`, or `[::1]`.
- `path` is the page in the Console, such as `/kv` or `/agents/<agent>/invocations/<id>`. It must start with one `/`. Without `path`, the link opens the Overview.

When this browser linked the project, the Console switches to it and opens the page. When it did not, the Console opens **Link project** with the app URL filled in. Select **Continue** to link the project, and the Console then opens the page. The link holds no secret. An absolute URL or a `//` path in `path` shows `Check the Console path`, so a link cannot send the browser to another site.

ViteHub uses these links too: the development server prints one at startup, and `consoleInvocationUrl()` and GitHub pull request comments link to a page of the hosted Console. To build a link in code, use `hostedConsoleUrl()` from `vite-hub/runtime`. It encodes both values, and throws a `TypeError` for a project URL or a path that the Console refuses:

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
- When the browser does not let the Console store data, the list stays in memory until the page reloads. The Console says so.
- To revoke access, remove the credential from the app, and restart or deploy the server. A Console that used that token then asks for a new one.

To remove a project, open the project list, select the **×** next to the project, and confirm **Forget project**. The browser removes the URL and the token. The project does not change.

### Self-host the Console

The hosted build is a static site, so any static host can serve it. Build it in a clone of the [ViteHub repository](https://github.com/vite-hub/vitehub):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run -t vite-hub#build
corepack pnpm --dir packages/vite-hub run build:console-hosted
```

The last command writes `index.html`, `404.html`, `_headers`, `oauth-client.json`, and `assets/` to `packages/vite-hub/.vitehub/console-hosted`. Set `VITEHUB_CONSOLE_ORIGIN` when you build to name your own `https://` origin in `oauth-client.json`:

```sh
VITEHUB_CONSOLE_ORIGIN=https://console.example.com corepack pnpm --dir packages/vite-hub run build:console-hosted
```

When you serve that folder:

- Serve it from an origin that serves nothing else, because every script on that origin can read the tokens.
- Answer unknown paths with `index.html`, so Console routes such as `/kv` load the app.
- Send the headers in `_headers`. Cloudflare and Netlify read that file. On other hosts, set the same headers. When a project uses `http:` on a host other than `localhost` or `127.0.0.1`, add it to `connect-src`.
- Add the Console origin to `console.origins` of each project.

On Cloudflare, `packages/vite-hub/console.hosted.wrangler.jsonc` is the configuration of console.vitehub.dev: a Worker with static assets and no Worker script. Copy it into the same folder, because `assets.directory` is relative to the file. Change `name` and `routes`, build, and run `wrangler deploy --config <file>`.

## Protect the Console route

The Console endpoint is the RPC at `/_vitehub/rpc`, the MCP endpoint, and the data routes of some sections. The skill files under `/_vitehub/.well-known/skills/` need no sign-in. ViteHub sends `X-Robots-Tag: noindex, nofollow` on these routes. This does not block access, so choose an access policy with `console.auth`:

| `auth` | Who can call the endpoint |
| --- | --- |
| `false` | Development only. Accepts local requests and calls from `console.origins`. A production build fails. |
| `'token'` | Callers that [sign each request](#sign-console-requests) with a key whose public key is in a `VITEHUB_CONSOLE_KEY_<NAME>` variable: the ViteHub Console and the CLI. This is the only mode that console.vitehub.dev can use in production. |
| `'app'` | Users with a session from the app [Auth](/docs/auth), such as the CLI with a session cookie, and MCP clients that sign in with [OAuth](/docs/development/mcp#set-up-oauth). |
| `{ ... }` | Users of a separate Console Auth: GitHub sign-in, a Console Auth server file, or Cloudflare Access. |

> [!WARNING]
> A production build with `auth: false` fails with `VITE_HUB_B0022`, including when `authorize` is set. Use `auth: 'token'` with a `VITEHUB_CONSOLE_KEY_<NAME>` variable, `auth: 'app'` with an app Auth Definition, or a Console Auth config. Development, CLI discovery, and `nuxi prepare` still accept `auth: false`.

When `console` is missing or `false`, a production build registers no Console route, and the host returns its normal not-found response. A development server without `console` serves only the Operations endpoint.

### Sign Console requests

`auth: 'token'` lets in only signed requests. Each caller has an Ed25519 key pair: the ViteHub Console has one for each linked app, and the CLI or a CI job has its own. The app keeps only the public keys, in `VITEHUB_CONSOLE_KEY_<NAME>` variables. A person or tool that reads the host env, or a pulled `.env` file, cannot sign a request. The build does not contain the keys.

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

The app origin is the origin of `vitehub({ publicUrl })` when it is set. Without it, it is the URL of the request as the host routed it. The server never reads `Host` or `X-Forwarded-*` headers for this, because any caller can set them. A Node.js server behind a proxy that ends TLS sees `http:`, so set `publicUrl` to its public URL. The origin stops a request signed for one app, such as a preview, from working on another app with the same key. Inside the 5 minutes, the same request can run again on the same app. TLS keeps others from reading it.

A command without `--url` calls the dev server of its project and sends it no credentials, so a dev server with `auth: 'token'` rejects the command. Pass `--url` with the origin of the dev server. The dev server also needs the public key in its environment:

```bash [Terminal]
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key> vitehub kv list --url http://localhost:3000
```

To use the commands without a key during development, set `auth: false` for the dev server only. The build keeps `auth: 'token'`. A dev server without sign-in answers only requests from this machine.

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
    console: { auth: command === 'serve' ? false : 'token' },
    kv: true,
    preset: 'node',
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
    console: { auth: command === 'serve' ? false : 'token' },
    kv: true,
    preset: 'node',
  })],
}))
```
:::
::

A signed caller gets every Console section. Set `console.authorize` to limit it. The context has `via: 'console'` with the `user` that the Console signed, the `team` that linked the app and the role of the user in it, or `via: 'cli'` with no `user`. Both have `key`, the `<NAME>` of the key. Operations get the same user as `context.user`. An Agent that calls Console operations as tools gets `via: 'agent'`, so allow it on its own:

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

### Call the Console from another origin

The hosted Console at `https://console.vitehub.dev`, or a Console that you host yourself, calls the app's endpoint from the browser. `console.origins` lists the origins that may do this:

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

The server accepts a cross-origin call only when `console.origins` lists the `Origin` of the request, and one of these is true:

- The request sends an OAuth access token for the Console resource as `Authorization: Bearer`, and the access check accepts it. This works when the app Auth [signs Consoles in with OAuth](#sign-a-console-in-with-oauth). Browsers do not sign, so `auth: 'token'` takes no cross-origin call.

- The app runs on the development server with `auth: false` or without a `console` option. No token is necessary.

Cookies never authorize a cross-origin call, so another site cannot use a signed-in browser session. A call from an origin that is not listed gets `403` with `CONSOLE_ORIGIN_REJECTED`. Cloudflare Access and session calls keep every Console data route same-origin.

The rule covers the Console data routes: the RPC at `/_vitehub/rpc`, impersonation at `/_vitehub/auth/manage`, and Env management at `/_vitehub/env/manage`. Env management still authenticates the request with its provider and checks the provider permissions.

The responses to a listed origin carry `Access-Control-Allow-Origin: <origin>`, `Access-Control-Expose-Headers: WWW-Authenticate`, and `Origin` in `Vary`, so the Console can read the challenge of a `401`. They never carry `Access-Control-Allow-Credentials`. A Nitro plugin answers the `OPTIONS` preflight of these routes before every app middleware, including the files in `server/middleware/`, and before app Auth. A listed origin gets `204` with `Access-Control-Allow-Methods: POST` and `Access-Control-Allow-Headers: authorization, content-type, x-vitehub-console`. Any other origin gets `403` with `CONSOLE_ORIGIN_NOT_ALLOWED`. The actual call then goes through your middleware as usual, so middleware that requires a session must let the Console data routes through and leave the check to the Console.

Check the setup with curl:

```bash [Terminal]
curl -i -X OPTIONS https://app.example.com/_vitehub/rpc \
  -H 'Origin: https://console.vitehub.dev' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type'
curl -i https://app.example.com/_vitehub/rpc \
  -H 'Origin: https://console.vitehub.dev' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"m":"sections.list","a":[{}],"t":"q","i":"1"}'
```

A same-origin call must come from the app origin. The route rejects opaque origins and browser requests marked `same-site` or `cross-site`. When a client sends no `Origin` and no Fetch Metadata, it must send `x-vitehub-console: 1`. A foreign page cannot add this header without a CORS preflight. The marker is not a credential: authentication and authorization still apply.

### Sign a Console in with OAuth

With `console: { auth: 'app' }` and [`consoleMcpOAuth()`](/docs/development/mcp#set-up-oauth) in the app Auth, the Console data routes accept OAuth bearer tokens from a client on an origin in `console.origins`. The app's Better Auth is the authorization server. The client uses no client secret. Install `@better-auth/cimd` at the version of `better-auth` that ViteHub uses. `consoleMcpOAuth()` loads it when the Auth starts. Without it, the server logs a warning, MCP sign-in keeps working, and no Console client can sign in.

The hosted Console and the built-in project linker support this OAuth sign-in flow. See [Sign in from the hosted Console](#sign-in-from-the-hosted-console). A custom OAuth client must implement the flow below and host its own client metadata document.

```ts [server/auth.ts]
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { consoleMcpOAuth } from 'vite-hub/console/auth'

export default defineAuth({
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  plugins: [...consoleMcpOAuth({ resource: 'https://app.example.com/_vitehub/mcp' })],
})
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts', origins: ['https://console.example.com'] },
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
    console: { auth: 'app', authorize: './server/console-authorize.ts', origins: ['https://console.example.com'] },
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
    console: { auth: 'app', authorize: './server/console-authorize.ts', origins: ['https://console.example.com'] },
  })],
})
```
:::
::

The Console resource is `<origin><base>/_vitehub`, such as `https://app.example.com/_vitehub`. It is one OAuth resource for the RPC and the other Console data routes. MCP keeps its own resource, `<origin><base>/_vitehub/mcp`. A token for one resource is rejected on the other with `401` and `error="invalid_token"`.

The client flow:

1. A signed-out call to a Console data route gets `401` with `WWW-Authenticate: Bearer realm="vitehub-console", resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/_vitehub"`.
2. The Console reads that protected resource metadata (RFC 9728) and the authorization server metadata at `/.well-known/oauth-authorization-server/api/auth`. Both answer CORS for listed origins.
3. The browser opens the authorization endpoint, `/api/auth/oauth2/authorize`, as a top-level page with `client_id`, `redirect_uri`, `resource`, `scope`, `state`, and PKCE `code_challenge` with `code_challenge_method=S256`. The person signs in and allows the Console on the app origin.
4. The Console exchanges the code with the `code_verifier` at `/api/auth/oauth2/token`. It sends no client secret.
5. The Console calls the data routes with `Authorization: Bearer <access token>`.

The client is public. Its `client_id` is the URL of a client ID Metadata Document (CIMD), such as `https://console.example.com/oauth-client.json`. Better Auth's [`cimd()` plugin](https://www.better-auth.com/docs/plugins/cimd) reads the document and creates the client. `console.origins` is the client allow list:

- The document URL must be on an `https://` origin that `console.origins` lists. The server checks this before it reads the document, and again at each authorization, token, and revocation request. An `http://localhost` entry allows bearer calls, but not an OAuth client.
- Each `redirect_uri` must be on the same origin as the `client_id`.
- PKCE with `S256` is required. The document must use `token_endpoint_auth_method: 'none'`.
- Only a client from the list can ask for the Console resource. Dynamically registered MCP clients cannot.

The server reads the document with the platform `fetch`, and never follows a redirect. It reads only from listed origins, which the app trusts, but it does not pin the DNS answer. On Node.js, pass `fetchClientMetadataResource` from `@better-auth/cimd/node` as `consoleMcpOAuth({ clientMetadataFetch })` to also refuse a host that resolves to a private address.

The token endpoint and the revocation endpoint, `/api/auth/oauth2/revoke`, answer CORS for listed origins, with no credentials. Consent stays on the app origin.

#### Scopes

| Scope | Allows |
| --- | --- |
| `vitehub:read` | `read` operations, and calls that only read |
| `vitehub:write` | `write` and `destructive` operations, such as `media.upload`, `channels.replay`, and the Auth actions |
| `offline_access` | A refresh token |

A call that needs a scope that the token does not have gets `403` with `CONSOLE_ACCESS_DENIED`. RPC calls include a `WWW-Authenticate` Bearer challenge with `error="insufficient_scope"` and the required `scope`. The token's user still goes through `console.authorize`, which decides the sections. A bearer call never starts or stops impersonation.

Auth management changes also need the user's Better Auth admin permissions and the live login session named by the token's `sid`. Auth uses that session for its plugin APIs and the action's actor. It sends no session cookie to the remote Console. Browser cookies on the request cannot change the OAuth actor.

#### Token lifetime and revocation

Console access tokens are signed JWTs that are valid for 15 minutes. A refresh token is valid for 7 days, and each refresh replaces it. MCP tokens keep Better Auth's defaults: 1 hour for an access token and 30 days for a refresh token.

- Revoking a refresh token at `/api/auth/oauth2/revoke` stops the next refresh.
- Revoking a refresh token does not invalidate an access token already issued: it can stay valid until it expires, at most 15 minutes after issuance. The server does not keep an access-token revocation list.
- A banned or deleted user loses access at once: each call reads the user from the Auth.
- Deleting or disabling the issuing client stops its Console access tokens at once. A token with a `sid` claim also stops when that login session is deleted or expires.
- Removing an origin from `console.origins` stops new sign-ins, refreshes, and calls from that origin after the next deploy.

### Use the app Auth

`auth: 'app'` reuses the app's server Auth Definition. Signed-in users reach the endpoint with their app session: the CLI with [`VITEHUB_CONSOLE_COOKIE`](/docs/development/cli), and MCP clients through [MCP OAuth](/docs/development/mcp#set-up-oauth). The hosted Console signs each person in with OAuth, as in [Sign in from the hosted Console](#sign-in-from-the-hosted-console).

`console: true` is the same as `auth: 'app'` with the access policy in `server/auth.ts`. Add access routes that decide who can use the Console:

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

The `role` field comes from Better Auth's `admin()` plugin. Use the app's role, permission, or allowlist. To give your account the admin role on a fresh deploy, set `VITEHUB_ADMINS`. See [Give the first admin role](/docs/auth/configure#give-the-first-admin-role).

- No session returns `401`.
- `false` returns `403`.
- A custom `Response` sets the rejection.

The app serves a sign-in page at `/_vitehub/sign-in`, with the email and password sign-in and the social providers of its Auth. It is the login and consent page of MCP OAuth. When a signed-in person opens it, it shows their access: **Signed in** with a link that opens the app in the hosted Console, or the access denied page. The denied page has the **Claim code** form of [the first admin role](/docs/auth/configure#give-the-first-admin-role).

Missing policy stops the build with `VITE_HUB_B0006`. Missing app Auth stops it with `VITE_HUB_B0005`. `console: true` never grants access to every signed-in user by itself.

For per-section rules, use an authorization file:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    auth: true,
    console: { auth: 'app', authorize: './server/console-authorize.ts' },
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

App Auth and the Console endpoint must use the same public origin, with the same protocol and port.

#### Sign in from the hosted Console

With `auth: 'app'`, each person signs in to the hosted Console with their own app account, so you do not share a token. The app Auth needs:

- [`consoleMcpOAuth()`](/docs/development/mcp#set-up-oauth). It issues access tokens for MCP at `<origin>/_vitehub/mcp` and for the Console at `<origin>/_vitehub`.
- `cimd()` from `@better-auth/cimd`. The hosted Console is an OAuth client whose `client_id` is the URL of its metadata document, `https://console.vitehub.dev/oauth-client.json`.
- The Console origin in `console.origins`. The default, `["https://console.vitehub.dev"]`, allows the hosted Console.

Install `@better-auth/cimd` at the same version as the app's Better Auth (`1.7.15` in this example):

```sh
pnpm add @better-auth/cimd@1.7.15
```

On Node, pass the package's secure metadata transport to `cimd()`. It validates public HTTPS destinations and redirects to prevent server-side request forgery. Other runtimes need a supported transport with the same protections; do not substitute ordinary `fetch`.

```ts [server/auth.ts]
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { defineAuth } from 'vite-hub/auth'
import { authDatabase } from 'vite-hub/auth/database'
import { consoleMcpOAuth } from 'vite-hub/console/auth'

export default defineAuth(() => ({
  database: authDatabase(),
  emailAndPassword: { enabled: true },
  plugins: [cimd({ fetchClientMetadataResource }), ...consoleMcpOAuth({ resource: 'https://app.example.com/_vitehub/mcp' })],
}))
```

Select **Link project** and enter the app URL. The Console reads the challenge of the app, opens `/_vitehub/sign-in`, and asks you to allow it. Then it calls the app with the access token.

The app accepts a token for `<origin>/_vitehub` only from an origin in `console.origins`, and only on the data routes. Same-origin requests and the CLI keep using the session. A token with only `vitehub:read` runs read operations; changes need `vitehub:write`. The access routes of the app Auth and `console.authorize` still decide what each person may use.

### Use Console Auth

Console Auth has its own Better Auth session and does not need the app's Auth. It protects the endpoint for the CLI and MCP clients. People sign in at `/_vitehub/sign-in`. On a Node host, the inline GitHub setup lets in only verified emails in `allowedEmails`:

```ts
import { vitehub } from 'vite-hub'

vitehub({
  console: {
    auth: {
      provider: 'github',
      allowedEmails: ['maintainer@example.com'],
      databasePath: '/var/lib/app/console-auth.sqlite',
      baseURL: 'https://agent.example.com',
    },
  },
  preset: 'node',
})
```

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and [`VITEHUB_SECRET`](/docs/env/app-secret) in the server environment. Console Auth signs sessions with a secret derived from `VITEHUB_SECRET`. `BETTER_AUTH_SECRET` wins when it is set, and `secretEnv` names another required variable. Rotating either secret signs out every Console session. `baseURL` is the public origin used for OAuth redirects. Set it when a proxy terminates TLS. The GitHub callback URL is `https://agent.example.com/_vitehub/api/auth/callback/github`. Put `databasePath` on persistent storage. Inline Console Auth uses `node:sqlite` and needs the Node preset.

When you switch from the app Auth to Console Auth, remove the `/_vitehub/**` access route from `server/auth.ts`. Otherwise both guards apply.

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

ViteHub sets the auth route to `/_vitehub/api/auth/**` and the cookie prefix to `vitehub_console`. It guards `/_vitehub/**`, but not the sign-in page and callback. Requests without a session get `401`. The server file must give a Better Auth database adapter on durable storage and a secret. ViteHub runs Better Auth migrations before the first protected request. Set `migrate: false` only when your own startup applies the schema. Use `console.auth.server` for a file in another place.

On Cloudflare, use `console: { auth: { provider: 'cloudflare-access' } }` with a Cloudflare Access application. See [Cloudflare](/docs/frameworks-hosts/cloudflare).

### Use another authentication library

In development, apps that use another authentication library can set `auth: false` and give the Console an `authorize` function. A production build refuses `auth: false`. In production, use `auth: 'token'` with a `VITEHUB_CONSOLE_KEY_<NAME>` variable, `auth: 'app'` with an app Auth Definition, or a Console Auth config. `authorize` still runs after authentication.

```ts
import { vitehub } from 'vite-hub'

vitehub({
  console: { auth: false, authorize: './server/console-authorize.ts' },
})
```

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

`authorize` works with every `auth` choice. Every Console route calls it with the Web `Request` before it reads data: RPC, invocation actions, Env management, Channel replay, Schedule runs, and Connections management. A `Response` from `authorize` goes out as it is. `authorize` returns one of these values:

| Result | Effect |
| --- | --- |
| `true` | Allows every Console section. |
| `{ sections: ['content'] }` | Allows only these section ids, with all their actions. An empty list returns `403`. |
| `{ sections: ['kv:read'] }` | Allows `kv` for reads only. `write` and `destructive` operations return `403`, unless the call only reads (`readOnlyWhen`). |
| `{ sections: ['blob:media'] }` | Allows Blob operations on the `media` store only. `'blob:media:read'` allows only reads. |
| `false` | Returns `403`. |
| A `Response` | Returns that response, for example a `401`. |

Any other value returns `500`. With `auth: 'app'` and session-based Console Auth, the context also has the signed-in `user`:

```ts [server/console-authorize.ts]
import { defineConsoleAuthorize } from 'vite-hub/console/auth'

export default defineConsoleAuthorize(({ user }) => {
  if (user?.role === 'admin') return true
  if (user?.role === 'editor') return { sections: ['content'] }
  return false
})
```

A section entry is the section id, or `'<section>:read'` for read only. A read grant allows only `kind: 'read'` operations and calls that `readOnlyWhen` marks as reads, on every surface (Console RPC, `vitehub <namespace> --url`, agent tools, MCP). Write routes such as Env management and Schedule runs refuse it, and so do write operations such as `channels.replay`, `agents.invoke`, and `media.upload`. With `'kv:read'` and `'kv'` together, the full grant wins. The Console hides write actions for a read grant.

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

The server checks the store of each call on every surface. A call without `store` uses `default`. A call to another store returns `403` (`CONSOLE_ACCESS_DENIED` over MCP), and the message names the needed grant, such as `'blob:default'`. `blob.list` returns only allowed stores in `stores`. A store grant does not open the Blob section, which needs `'blob'` or `'blob:read'`, so editors use the [Media library](/docs/content/console#media-library) of Content. A store named `read`, or with `:` in its name, needs the whole `'blob'` grant.

::warning
Breaking change: a section grant now includes its write actions. `{ sections: ['kv'] }` lets a user set and delete keys, `'blob'` lets them upload and delete blobs, and `'rate-limits'` lets them reset counters. For a read-only role, use `'<section>:read'`, such as `{ sections: ['kv:read', 'blob:read'] }`.
::

Section ids are the ids in the Console URL, such as `env`, `connections`, `agents`, `usage`, `content`, `blob`, `databases`, `kv`, `workspaces`, `workflows`, `queues`, and `schedules`. Each route and operation declares its section, and the server returns `403` for a section outside the list. Write actions need the section that owns them:

- Env management: `env`. Connections management: `connections`.
- Agent Invocations and Channel replay: `agents`. Schedule runs: `schedules`.
- Workflow starts, cancels, and resumes: `workflows`.
- Content saves and publishes: `content`. Content then checks `content.can()`, so `defineContent({ authorize })` decides which collections and actions an editor gets.

The Console shows only allowed sections, but the server check is the security boundary.

### How each mode checks a request

Each Console route checks access itself. The Console Auth middleware stays as a first layer in front.

| Configuration | Check in each Console route |
| --- | --- |
| `auth: false` | Allows development access, including calls from `console.origins`. A production build fails with `VITE_HUB_B0022`. |
| `auth: 'app'` | Checks the Primary Auth Session and every Auth access route that protects the Console. Returns `401` or `403`. With `consoleMcpOAuth()`, also accepts an OAuth access token for the Console resource, also from `console.origins`. |
| `auth: 'token'` | Verifies the [Ed25519 signature](#sign-console-requests) with the `VITEHUB_CONSOLE_KEY_<NAME>` that it names. Returns `401`, or `500` when no key is set or one is malformed. Takes no cross-origin call. |
| `auth: { ... }` | Checks the Console Auth Session and its `authorize` callback. Returns `401` or `403`. |
| `auth: { provider: 'cloudflare-access' }` | Verifies the Cloudflare Access token. Development has no Access edge, so the development server allows the request. |
| `authorize` | Runs after any check above. It can reject the request or limit it to some sections. |

All Console paths sit under the application base: an explicit ViteHub application base (set from Nuxt `app.baseURL`), else a root-relative Vite `base`. With `base: '/portal/'`, host middleware must protect `/portal/_vitehub/**` for every method, and the hosted Console links the app as `https://app.example.com/portal`. Primary Auth access routes must use the application base too. Built-in Console Auth adds it for you.

### Share a development server

A development server without sign-in trusts whoever can reach it, so the endpoint answers only this machine. A tunnel or a reverse proxy on this machine, such as `cloudflared`, `ngrok`, `tailscale serve`, an `ssh -R` tunnel, or Caddy, connects to the dev server from `127.0.0.1` too. To share a dev server through one, set `console.auth`.

A request with a `Host` other than `localhost`, a `.localhost` name, `127.0.0.1`, or `[::1]`, a peer address that is not loopback, or a forwarding header gets `403` with `CONSOLE_LOOPBACK_ONLY`. The forwarding headers are `Forwarded`, `Via`, any `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, `CDN-Loop`, any `CF-*`, `Fly-Client-IP`, `Fastly-Client-IP`, `X-Vercel-Forwarded-For`, any `Ngrok-*`, and any `Tailscale-*`. The hosted Console in your browser calls the dev server from this machine, so it passes this check.

A forwarder that copies raw TCP bytes, such as `ssh -R` or `tailscale serve --tcp`, adds no header, so ViteHub cannot tell its requests from yours. Only sign-in protects a dev server behind one.

When the endpoint has no sign-in, the dev server prints a note at startup. A server that listens on more than loopback, for example with `--host`, prints it as a warning.

### Start Agent Invocations

`invoke` lets the Console start Agent Invocations and run manual Schedules. It is `true` on the development server and `false` in a production build by default:

```ts
import { vitehub } from 'vite-hub'

vitehub({
  console: { auth: 'token', authorize: './server/console-authorize.ts', invoke: true },
})
```

The invocation routes call your access policy, so it decides who can start invocations. A user also needs the `agents` section. `invoke: false` keeps inspection and turns off new invocations. Fixture mode always turns them off.

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

**Skill index** opens [ViteHub's published Skill index](https://vitehub.dev/.well-known/skills/index.json), which is not your app's Skills.

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
| Agent Console startup fails on a hosted preset | Set `agent.invocations: 'database'`, or give every Agent Definition one durable journal. The default SQLite journal needs a writable, persistent filesystem. |
| The hosted Console cannot reach a deployed app | Use `auth: 'token'`, keep the Console origin in `console.origins`, then build and deploy again. |
| `console: true` reports missing app Auth or Console access policy | Set `auth: true` and allow the Console routes in the app Auth Definition. |
| ViteHub says `console.auth` is required (`VITE_HUB_B0004`) | Add `auth` to the `console` object: `false`, `'app'`, `'token'`, or a Console Auth config. |
| `console.signInPage` fails the build | The option is removed with the Console page that apps served. Remove it. |
| `auth: 'app'` fails with `VITE_HUB_B0005` | Set `auth: true` and add an Auth Definition, such as `server/auth.ts`. |
| `auth: 'app'` fails with `VITE_HUB_B0006` | Set `console.authorize`, or add Auth access routes with an `authorize` callback for the routes in the message. |
| The build or server warns that `auth: false` has no sign-in | Add `console.authorize`, or set `console.auth` to `'token'`, `'app'`, or a Console Auth config. |
| Console routes return `500` with "console.authorize must return" | Return `true`, `false`, a `Response`, or `{ sections: string[] }` from `authorize`. Use the global `Response`. |
| A call returns `401` | Send the token, or sign in through the app Auth or Console Auth. |
| A call returns `403` | `authorize` or the `auth` check rejected this caller, or `authorize` returned `{ sections }` without that section id. |

### Console error codes

A `401` from a Console route carries `WWW-Authenticate: Bearer realm="vitehub-console"`. The MCP endpoint keeps its own challenge with `resource_metadata`.

Each failed Console request returns JSON with a stable `code`, a `message` that says why, a `fix`, and a `docs` link. RPC failures also keep `ok: false` and `status`.

| Code | Status | Fix |
| --- | --- | --- |
| `CONSOLE_SIGN_IN_REQUIRED` | `401` | Sign in again. |
| `CONSOLE_ACCESS_DENIED` | `403` | Use an account or a token that the access policy allows. |
| `CONSOLE_MANAGER_REQUIRED` | `403` | The session has no user id, so a management action cannot name its manager. Make sure the Auth Definition that protects the Console returns a user with an id. |
| `CONSOLE_IMPERSONATING` | `403` | This caller uses an impersonation session. Stop impersonating to get your own session back. |
| `CONSOLE_DEVELOPMENT_ONLY` | `403` | Rebuild and deploy with an explicit `console.auth` choice. Set `console.authorize` to restrict who may use it. |
| `CONSOLE_LOOPBACK_ONLY` | `403` | The development server has no sign-in and answers only this machine. See [Share a development server](#share-a-development-server). |
| `CONSOLE_ORIGIN_REJECTED` | `403` | Call the endpoint from the app origin, or from an origin in `console.origins` with an OAuth access token. Proxies must forward the public `Host` and `Origin` headers. See [Call the Console from another origin](#call-the-console-from-another-origin). |
| `CONSOLE_ORIGIN_NOT_ALLOWED` | `403` | Add the origin to `console.origins`, then build and deploy again. |
| `CONSOLE_SIGNATURE_MISSING` | `401` | Open the app from the ViteHub Console, or set `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` for the CLI. See [Sign Console requests](#sign-console-requests). |
| `CONSOLE_SIGNATURE_STALE` | `401` | Sync the clock of the machine that signs. |
| `CONSOLE_SIGNATURE_ORIGIN` | `401` | Link the app with the URL that serves it. Behind a proxy that ends TLS, set `vitehub({ publicUrl })`. |
| `CONSOLE_SIGNATURE_INVALID` | `401` | Use the private key whose public key is in the `VITEHUB_CONSOLE_KEY_<NAME>` that the signature names. |
| `CONSOLE_SIGNATURE_BODY` | `401` | Send the body that the signature covers. A proxy must not change it. |
| `CONSOLE_KEY_UNKNOWN` | `401` | Set the `VITEHUB_CONSOLE_KEY_<NAME>` line from the Console setup page or `vitehub secret console-key`, then restart or deploy. |
| `CONSOLE_KEY_NOT_CONFIGURED` | `500` | Set a `VITEHUB_CONSOLE_KEY_<NAME>` variable, then restart or deploy. |
| `CONSOLE_KEY_MALFORMED` | `500` | Set the 43 base64url characters of the public key, with no quotes or spaces, then restart or deploy. |
| `CONSOLE_ACCESS_NOT_CONFIGURED` | `500` | Build the app with the ViteHub plugin. |
| `CONSOLE_AUTHORIZE_REQUIRED` | `500` | Set `console.authorize`. |
| `CONSOLE_AUTH_NOT_CONFIGURED` | `500` | Add an Auth Definition, or configure Cloudflare Access. |
| `CONSOLE_MCP_ORIGIN_REQUIRED` | `503` | Set `vitehub({ publicUrl })` or `console.mcp.resource`, so [MCP OAuth](/docs/development/mcp#set-up-oauth) has an origin a request cannot change. |
| `CONSOLE_MCP_OAUTH_INCOMPLETE` | `503` | Add `jwt()` and `oauthProvider({ resources, scopes })` to the Auth, as in [Set up OAuth](/docs/development/mcp#set-up-oauth). |
| `CONSOLE_CONNECTIONS_MANAGEMENT_UNAVAILABLE` | `404` | Set `connections: { management: true }` for production. |
| `CONSOLE_ENV_MANAGEMENT_UNAVAILABLE` | `404` | Give the Env declaration a management bridge. |
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

A route that fails with its own diagnostic keeps that code, such as `VITE_HUB_R0114`. Connections and Env management routes keep their `CONNECTION_*` and `ENV_BRIDGE_*` codes and add `fix` and `docs`.

See [Agent Invocations](/docs/agents/invocations) for custom stores and the invocation lifecycle. To build your own inspection page, use [UI parts](/docs/ui) such as [Trace](/docs/ui/trace) and [Code block](/docs/ui/code-block).

### Image upload boundaries

Image uploads need `console.invoke`. The Agent and invoker profile you chose at submit stay fixed while images upload. If you switch Agents, the pending request stays with the first Agent.

- Images must be PNG, JPEG, WebP, or GIF: at most ten images and 10 MiB in total per invocation.
- Blob storage must return an HTTP or relative serving URL.
- If storage or setup fails before the Agent takes the images, the Console rolls back the uploads.
- Images given to an Agent stay under `_vitehub/console/attachments/` and follow your Blob retention policy.
