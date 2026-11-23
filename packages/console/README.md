# @vite-hub/console

The ViteHub Console as its own app. You deploy it once, people sign in, and each team links its apps. The Console server signs each call to an app's Operations endpoint with the key of that app's link. Apps do not serve Console pages, need no CORS, and run no OAuth server for the Console. console.vitehub.dev runs this app.

This package is private and in progress. `vitehub console deploy` comes next.

## How it works

1. A person signs in with GitHub or a passkey. A new account gets a personal team. People can make more teams and invite others.
2. An owner or admin of a team links an app with its URL. The Console makes an Ed25519 key pair for the link. It keeps the private key encrypted and shows the public key and the variable that holds it, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC`.
3. You set that variable on the app and deploy. The app needs `console: true`.
4. The Console page calls `/p/<project>/_vitehub/rpc` on the Console origin. The Console server checks that the person is a member of the team that owns the project, then signs the call and sends it to the app. The signature covers the exact body bytes and the person who calls: their user id, name, email, team id, and role. The app's `console.authorize` receives them with `via: "console"`. See [Sign Console requests](https://vitehub.dev/docs/console/signed-requests).

Each link has its own variable, so two teams can link the same app, and unlinking one leaves the other.

The migration `0002_sign_project_calls` removes the links that an older Console made with bearer tokens, because they cannot sign. Link those apps again and set the new line.

The project never sees the cookies, `Origin`, or `Authorization` header of the Console page, and the page never sees the private key or the project's cookies. The forward sends only the one Console route of a project, `POST /_vitehub/rpc`. It stops at a redirect, and names Cloudflare Access when Access sent the call to its sign-in page. It refuses a body that is larger than a 9 MiB file as base64, plus 64 KiB.

The forward sends at most 600 calls a minute from one person to one project. Calls from the Console page, an API key, and the ViteHub MCP count together. The next call gets `429` with `CONSOLE_FORWARD_RATE_LIMITED` and a `Retry-After` header, and does not reach the project. The count is in Better Auth's `rate_limit` table, so every server process sees the same count.

Forwarded responses use a Console-owned sandbox policy, `nosniff`, and attachment disposition. JSON keeps its media type; other bodies use `application/octet-stream`. The client can read JSON and binary data, while project content cannot run as a document or script on the Console origin.

## Accounts and teams

Sign-in uses Better Auth with `authDatabase()`, `organization()`, and `passkey()` from `@better-auth/passkey`. A team is a Better Auth organization.

- **GitHub**: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The callback URL of the GitHub OAuth app is `<console origin>/api/auth/callback/github`. Without them, the sign-in page offers passkeys only.
- **Passkeys**: the first passkey makes the account, with the name the person types. Such an account has no email address. Its email is a placeholder on the reserved `passkey.invalid` domain, so it cannot accept an invitation until the person signs in with GitHub. A signed-in person adds passkeys and GitHub from the account menu.
- **Teams**: every session opens a team. The first sign-in makes a personal team with the person as `owner`. Owners and admins link and unlink projects and invite people. Members open the projects. An invitation is a link to `/invite/<id>` for the email of a GitHub account, valid for 48 hours. The Console sends no email.

The server keeps at least one passkey or linked GitHub account when a sign-in method is removed, including concurrent requests from other tabs. Apply the database migrations on each host: they enforce this rule in the same statement as the deletion.

## CLI sign-in and API keys

`vitehub login` signs the CLI in with the device flow of RFC 8628. Better Auth's `deviceAuthorization()` keeps the codes in the `device_code` table, and `consoleCliDeviceFlow()` in `src/device.ts` adds the Console's own steps:

1. The CLI posts `client_id=vitehub-cli` and the machine name to `POST /api/auth/device/code`. Other client ids get `invalid_client`.
2. The person opens `/device`, signs in, checks the machine name and the code, and picks a team. **Approve** calls `POST /api/auth/cli/approve`; **Deny** calls `POST /api/auth/device/deny`. Only the person who opened the code can approve it.
3. The CLI polls `POST /api/auth/cli/token`. It answers `authorization_pending`, `slow_down` when the CLI polls faster than every 5 seconds, `access_denied`, or `expired_token` after 15 minutes. After approval it answers an API key for the team, valid for 90 days, once.

Better Auth's own `/device/approve` and `/device/token` are off, so the device flow never gives the CLI a session. Better Auth's limiter counts `/device/code` (10 a minute) and `/cli/token` (30 a minute) for each address in the `rate_limit` table.

An API key starts with `vhk_`. `console_api_keys` keeps its SHA-256 hash and its first 8 characters, never the key. A key acts as the person in one team with their current role there, and stops working when it expires, when it is revoked, or when the person leaves the team. A key can name projects of the team: it then lists and opens only those, and links or unlinks none. People make, list, and revoke keys in **Account settings** > **API keys**; the Console shows a new key once.

Requests send the key as `Authorization: Bearer vhk_...`. The `/api/projects` routes and the forward accept it in place of a session.

## Env values

Whoever runs a Console can read the values that it stores. So a Console stores no env values until its operator turns them on, and **the hosted Console at console.vitehub.dev never stores values**. Without them, keep values in `.env.<stage>` files and on the host.

To turn values on in a self-hosted Console, set `VITEHUB_CONSOLE_ENV_VALUES=1` and `VITEHUB_CONSOLE_ENV_KEY`, a 32-byte key from `openssl rand -base64 32`. Keep a copy of the key outside the database: without it, the values cannot be read. It is not `VITEHUB_CONSOLE_SECRET`. While values are off, every env route answers `404` with `CONSOLE_ENV_VALUES_OFF`, and the **Env values** page says that this Console does not store values.

The values use `createDatabaseEnvStore()` from `@vite-hub/env/database` in the Console database: AES-256-GCM, a revision for each write, and an activity log. Each app and stage is one namespace, `<project id>:<stage>`. Every app has `production` and `preview`, and a stage that holds a value appears in the list. A stage is lowercase letters, digits, `-`, and `_`.

- Members see the names and when each one changed.
- Owners and admins set, replace, delete, and reveal values. A key that names projects does this only on those projects.
- Each write, delete, and reveal goes in the env activity first, with `operation` `console.set`, `console.delete`, or `console.reveal`. The actor is the person of a session, or `api-key:<key id>` with the person in `target`. A reveal writes a `started` row before it reads a value, then `succeeded` or `failed` with the same `operationId` before it answers. The activity never holds a value.
- `vitehub env pull --from console` reveals every value of a stage and writes `.env.<stage>`.

### Rotate the env key

`VITEHUB_CONSOLE_ENV_KEYS` is a keyring: comma-separated keys, the current key first, then the previous keys. New writes use the current key, and a value that a previous key sealed still reads. Set it in place of `VITEHUB_CONSOLE_ENV_KEY`. With both set, every env route answers `500` with `CONSOLE_ENV_KEY_INVALID`.

1. Create a new key with `openssl rand -base64 32`, and keep a copy outside the database.
2. Remove `VITEHUB_CONSOLE_ENV_KEY`, set `VITEHUB_CONSOLE_ENV_KEYS=<new key>,<old key>`, and deploy.
3. Open the **Env values** page, or call any env route. The first env request of each Console process seals every stored value of every app and stage with the new key, and the host log gets one line: `[vitehub] Env values: sealed <n> values again with the current key, ...`. The values and their revisions stay the same. If it fails, the log says so, reads still work with both keys, and the next request tries again.
4. When the log line is there, set `VITEHUB_CONSOLE_ENV_KEY=<new key>`, remove `VITEHUB_CONSOLE_ENV_KEYS`, and deploy. Delete the old key.

Do not remove the old key before step 3 is done: a value that only the old key opens can no longer be read. A reveal of such a value answers `500` with `CONSOLE_ENV_KEY_MISSING`, returns no value, and logs the reveal as `failed`. Put the old key back in `VITEHUB_CONSOLE_ENV_KEYS` to read it again.

## ViteHub MCP

The Console serves the ViteHub MCP on two addresses. MCP clients do not sign in on an address that answers without a token, so docs and account tools need two.

| Address | Sign-in | Tools |
| --- | --- | --- |
| `/mcp` | None. It answers `tools/list` without a token and advertises no OAuth metadata. | `list-pages` and `get-page`. Each call goes to the docs MCP at `https://vitehub.dev/mcp`. |
| `/mcp/account` | OAuth with the Console account. Without a token it answers `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/account"`. | The docs tools, and `list_apps`, `link_app`, `check_app`, `unlink_app`, `list_operations`, `read_operation`, and `run_operation`. |

```sh
claude mcp add --transport http vitehub https://console.vitehub.dev/mcp/account
```

The client registers itself (Dynamic Client Registration), and the browser opens `/oauth`. There the person signs in with GitHub or a passkey and allows the client. `mcpOAuth()` in `server/auth.ts` adds Better Auth's `jwt()` and `oauthProvider()`. Their tables (`jwks`, `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, and the others) are in the first migration.

The account tools act on the team that the person opened last in the Console, else their first team, and they keep the rules of the HTTP routes because they call the same code:

- `link_app` and `unlink_app` need the `owner` or `admin` role. `link_app` returns the variable line that the app must set, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>`.
- `check_app` calls `project.get`, and `list_operations` returns the sections and operations of the app. An app with an older vite-hub refuses the MCP fields of the caller as a malformed header (`CONSOLE_SIGNATURE_INVALID`). `check_app` then calls `project.get` as the Console page does, so the app shows as linked, and the other tools answer `CONSOLE_APP_VITEHUB_OUTDATED` with the version of the app. They do not send the call without the MCP fields, because the app would then run it without its MCP rules.
- The account tools call the app's Operations endpoint through the forward, signed with the key of the link for the person, with `surface: "mcp"` in the signed `x-vitehub-caller`. The Agent's access token never reaches the app. The app applies its MCP rules: it refuses operations with `mcp: false` (such as `documents.action`), runs the others with the `mcp` surface (so `content.save` needs `ifDigest`), and lists only those in `project.get`.
- `read_operation` runs an operation that only reads. The Console signs `readOnly: true` in the caller, and the app refuses a write or destructive call. The tool has `readOnlyHint: true`, so an MCP client can run it without asking the person. For example, `env.inspect` returns the Server Env status of an app, with the host variable names and no values.
- `run_operation` runs an operation that changes data. It has `destructiveHint: true`, so an MCP client can ask the person first.
- `run_operation` refuses a destructive call with `409` until the Agent sends `confirm: true`. The Console then signs `confirmed: true` in the caller, so a header cannot add or remove the confirmation. The tool tells the Agent to ask the person first.

## Configure

| Variable | Use |
| --- | --- |
| `BETTER_AUTH_SECRET` | The key that signs sessions, at least 32 characters. |
| `VITEHUB_CONSOLE_PUBLIC_URL` | Build-time public URL of this Console, such as `https://console.example.com`. Required on Node (including Docker) to accept signed calls through a Console link. Rebuild and redeploy when it changes. `BETTER_AUTH_URL` alone does not configure this origin. |
| `VITEHUB_CONSOLE_SECRET` | The key that encrypts the private keys of the project links, at least 32 characters. Create it with `openssl rand -hex 32`. If it changes, the Console cannot open the keys, and teams must link their projects again. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional. GitHub sign-in. |
| `VITEHUB_CONSOLE_ALLOW_PRIVATE` | `true` lets the Console link private addresses, such as `localhost`, `10.0.0.8`, or `*.internal`. Off by default, so a person who links a project cannot make the Console fetch an address in its own network. The check reads the host name: a public name that resolves to a private address passes it. |
| `VITEHUB_CONSOLE_COMMENTERS` | Optional. The emails, comma-separated, of the people who may comment on the Console's own pages. Anyone can sign up, so a signed-in account is not enough. Without it, nobody may. |
| `VITEHUB_CONSOLE_ENV_VALUES` | Optional. `1` stores env values in this Console. Off by default. The operator can read the stored values. See [Env values](#env-values). |
| `VITEHUB_CONSOLE_ENV_KEY` | The 32-byte key that encrypts env values, as base64 or 64 hex digits. Required when `VITEHUB_CONSOLE_ENV_VALUES` is `1`, unless `VITEHUB_CONSOLE_ENV_KEYS` is set. |
| `VITEHUB_CONSOLE_ENV_KEYS` | Optional. In place of `VITEHUB_CONSOLE_ENV_KEY` during a rotation: comma-separated keys, the current key first. See [Rotate the env key](#rotate-the-env-key). |
| `VITEHUB_CONSOLE_KEY_<NAME>` | Optional. The public key of a link to this Console from a Console, such as itself. See [Link the Console to itself](#link-the-console-to-itself). |

## Link the Console to itself

The Console is a ViteHub app with Comments and `console: true`, so you can comment on its pages and triage the comments in a Console, as with any app:

On Node (including Docker), first build and deploy with `VITEHUB_CONSOLE_PUBLIC_URL` set to the Console's own public URL, as in the VPS steps below. This configures the trusted origin for signed calls; setting it only when starting the server is too late.

1. Set `VITEHUB_CONSOLE_COMMENTERS` to your email, such as `wrangler secret put VITEHUB_CONSOLE_COMMENTERS --config .output/server/wrangler.json`. On the next page you open, the tools pill shows **Comments**.
2. In the Console, **Link an app** with the Console's own URL, such as `https://console.vitehub.dev`. The next page shows a line `VITEHUB_CONSOLE_KEY_CONSOLE_<ID>=<public key>`.
3. Set that line on the Console, such as `wrangler secret put VITEHUB_CONSOLE_KEY_CONSOLE_<ID> --config .output/server/wrangler.json`, then click **Check connection**.

A call through the link comes from the Console's server to its own public URL, signed like a call to any other app. Comments in the Console follow the same list: the person that the Console signs needs an email in `VITEHUB_CONSOLE_COMMENTERS`.

## Routes

The `/api/projects` routes and the forward need a session or an API key. They act on the session's active team, and a person who is not a member gets `403`.

| Route | Use |
| --- | --- |
| `GET /api/account` | The person, their teams, their roles in the session's team, and its projects, with one session check. The page HTML starts this read with `<link rel="preload">` when the request has a session cookie. Signed out, it answers `401`. |
| `GET /api/projects` | The projects of the team, with the public key of each link (`publicKey`) and its variable (`keyVariable`). |
| `POST /api/projects` | Owners and admins link a project: `{ "url": "https://app.example.com", "label": "Docs" }`. Answers `201` with the project, `400` for a URL that is not `https://` or is private, and `409` when the team already linked the URL. |
| `POST /api/projects/<id>/check` | Call `project.get` on the project. `linked` is `true` once the project has the public key. |
| `PATCH /api/projects/<id>` | Owners and admins rename a project: `{ "label": "Docs" }`. `{ "label": null }` removes the label, so the Console shows the name that the app reports. The key of the link does not change. |
| `DELETE /api/projects/<id>` | Owners and admins unlink a project. Remove its variable from the project as well. |
| `/p/<id>/_vitehub/**` | The forward to the project's data routes. |
| `POST /mcp`, `POST /mcp/account` | The ViteHub MCP. `/mcp` needs no session; `/mcp/account` needs an OAuth access token instead of a session. |
| `GET /oauth` | The sign-in and consent page of MCP clients. It needs no session. |
| `GET /api/sign-in-methods` | `{ "github": true }` when GitHub sign-in is configured. |
| `GET /api/whoami` | With an API key: the person, the team, the roles, the projects of the key, and its expiry. `vitehub whoami` calls it. |
| `GET /api/api-keys`, `POST /api/api-keys` | With a session: list the person's API keys, or make one with `{ "name": "CI", "teamId": "<team>", "projectIds": ["<project>"], "days": 90 }`. Only `name` is required. The answer of `POST` holds the key once, in `key`. |
| `DELETE /api/api-keys/<id>` | With a session, revoke one of the person's keys. With an API key, `DELETE /api/api-keys/current` revokes that key, as `vitehub logout` does. |
| `GET /api/projects/<id>/env` | The stages of a project. Every env route answers `404` with `CONSOLE_ENV_VALUES_OFF` while values are off. |
| `GET /api/projects/<id>/env/<stage>` | The names of a stage and when each changed, and `canReveal`. Never values. |
| `PUT /api/projects/<id>/env/<stage>/<NAME>` | Owners and admins set or replace a value: `{ "value": "..." }`. |
| `DELETE /api/projects/<id>/env/<stage>/<NAME>` | Owners and admins delete a value. |
| `POST /api/projects/<id>/env/<stage>/reveal` | Owners and admins read values: `{ "names": ["API_TOKEN"] }`, or `{}` for every value of the stage. |
| `GET /api/projects/<id>/env/<stage>/<NAME>/activity` | Owners and admins read the writes and reveals of a name. |
| `GET /api/projects/<id>/site` | Site access of a project: the team members, the browsers with a pass (`sessions`), the open guest invites, and the roles (`grants`). |
| `POST /api/projects/<id>/site/invites` | Invite a guest: `{ "name": "Grace", "grants": ["comments-write"], "expiresInDays": 7, "path": "/docs" }`. `expiresInDays` is 1, 7, or 30. Guests never get `console`. The answer of `201` holds the link `/i/<secret>` once. |
| `DELETE /api/projects/<id>/site/invites/<id>` | Revoke an invite that nobody opened. |
| `POST /api/projects/<id>/site/codes` | A one-time code for the caller, such as for a phone: `{ "path": "/runs/42" }`. The answer holds the link `/go/<secret>`. It works once, for 10 minutes. |
| `DELETE /api/projects/<id>/site/sessions/<id>` | Revoke the pass of a browser. The Console signs no new token for it. |
| `POST /api/projects/<id>/site/token` | A Site access token for the caller, a member of the team: `{ "path": "/docs", "state": "<state hash of the app>" }`. The answer is `{ "url": "<app>/_vitehub/site?token=vst1.…" }`. |
| `GET /visit?app=<app URL>&state=<state hash>&return=<path>` | The app's `/_vitehub/site` sends a browser here. With a pass of this browser, or a session of a team member, the Console signs a token for 60 seconds and goes back to the app. Else it opens `/open`, which asks for a sign-in. It needs no session. |
| `GET /i/<secret>`, `GET /go/<secret>` | Open a guest invite or a one-time code once. The browser gets a pass for 7 days, renewed on each visit, and goes to the app's `/_vitehub/site`. A second open answers `410`. They need no session. |
| `GET /device` | The page where a person approves `vitehub login`. It needs no session to open. |
| `/api/auth/**` | Better Auth: sign-in, passkeys, and teams (`/api/auth/organization/*`). |

Other paths answer with the Console page, built by `pnpm --filter vite-hub build:console-account`. Build it before the app.

## Deploy

`vitehub console deploy` will run these steps for you. Until it ships, run them from `packages/console`. Each host keeps the Console's data in its own database, so run the same steps again to update.

| Host | Database | Limits |
| --- | --- | --- |
| VPS (Node, Docker) | SQLite in `/data`, migrated when the server starts | You run TLS, such as Caddy. It can link apps on a private network with `VITEHUB_CONSOLE_ALLOW_PRIVATE=true`. |
| Cloudflare Workers | D1 | Cannot reach private addresses. The build sets `global_fetch_strictly_public`, without which a Worker that fetches another Worker on the same zone gets error 1042. |
| Vercel | Hosted libSQL, such as Turso from the Vercel Marketplace | Request bodies stop at 4.5 MB, so Blob and Media uploads above that fail through the Console. Cannot reach private addresses. |

### VPS with Docker

Build on Linux with glibc and Node.js 24, matching the CPU architecture (x64 or arm64) of the `node:24-slim` image on the server. The output contains the build machine's native libSQL module. Output built on macOS, Windows, or Linux with musl (such as Alpine) is incompatible with this image.

```sh
VITEHUB_CONSOLE_PUBLIC_URL=https://console.example.com VITEHUB_DATA_DIR=/data vp build
export BETTER_AUTH_URL=https://console.example.com BETTER_AUTH_SECRET=$(openssl rand -hex 32) VITEHUB_CONSOLE_SECRET=$(openssl rand -hex 32)
docker compose up -d --build
```

Keep `VITEHUB_CONSOLE_SECRET` in a password manager: without it, the Console cannot open the private keys of the project links. The `console-data` volume holds the database. Without Docker, run `node .output/server/index.mjs` with the same variables. The build writes the database path, so build with the `VITEHUB_DATA_DIR` that the server uses.

### Cloudflare

```sh
wrangler d1 create vitehub-console    # note the database id
VITEHUB_HOST=cloudflare VITEHUB_CONSOLE_D1_ID=<id> vp build
wrangler d1 migrations apply DB --remote --config .output/server/wrangler.json
wrangler secret put VITEHUB_CONSOLE_SECRET --config .output/server/wrangler.json   # and BETTER_AUTH_SECRET, GITHUB_CLIENT_SECRET
wrangler deploy --config .output/server/wrangler.json
```

### Vercel

Add a Turso database from the Vercel Marketplace to the project, so the project has `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Then:

```sh
VITEHUB_HOST=vercel TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... vitehub database migrate
VITEHUB_HOST=vercel vp build
vercel env add VITEHUB_CONSOLE_SECRET    # and BETTER_AUTH_SECRET, BETTER_AUTH_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
vercel deploy --prebuilt --prod
```

## Develop

```sh
corepack pnpm --dir packages/console exec vitehub database migrate
VITEHUB_CONSOLE_SECRET=$(openssl rand -hex 32) VITEHUB_CONSOLE_ALLOW_PRIVATE=true corepack pnpm --dir packages/console run dev
corepack pnpm --dir packages/console run test
```

CI builds the Console for each host from the same commit and runs the same checks against the running build: the real page, a write and read in the database after the migrations, and `/mcp`. Then it checks env values on the database of that host. It writes a test owner, a member, and their API keys into the database, and starts the build three times: with values off, as console.vitehub.dev runs, with values on, and with values on and another key. With values on, an owner sets, lists, reveals, and deletes a value over HTTP, a member gets `403`, the activity and the database hold no plain value, and another key opens no value: the reveal answers `CONSOLE_ENV_KEY_MISSING` and the activity logs it as failed. Run them for one host after you build the page:

```sh
cd packages/console
VITEHUB_HOST=node vp build && node scripts/host-smoke.mjs node    # or cloudflare, vercel
node scripts/smoke.mjs https://console.example.com                # only the checks, against a running Console
```
