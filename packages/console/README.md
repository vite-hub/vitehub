# @vite-hub/console

The ViteHub Console as its own app. You deploy it once, people sign in, and each team links its apps. The Console server signs each call to an app's Operations endpoint with the key of that app's link. Apps do not serve Console pages, need no CORS, and run no OAuth server for the Console. console.vitehub.dev runs this app.

This package is private and in progress. `vitehub console deploy` comes next.

## How it works

1. A person signs in with GitHub or a passkey. A new account gets a personal team. People can make more teams and invite others.
2. An owner or admin of a team links an app with its URL. The Console makes an Ed25519 key pair for the link. It keeps the private key encrypted and shows the public key and the variable that holds it, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC`.
3. You set that variable on the app and deploy. The app needs `console: true`.
4. The Console page calls `/p/<project>/_vitehub/rpc` on the Console origin. The Console server checks that the person is a member of the team that owns the project, then signs the call and sends it to the app. The signature covers the exact body bytes and the person who calls: their user id, name, email, team id, and role. The app's `console.authorize` receives them with `via: "console"`. See [Sign Console requests](https://vitehub.dev/docs/development/console#sign-console-requests).

Each link has its own variable, so two teams can link the same app, and unlinking one leaves the other.

The migration `0002_sign_project_calls` removes the links that an older Console made with bearer tokens, because they cannot sign. Link those apps again and set the new line.

The project never sees the cookies, `Origin`, or `Authorization` header of the Console page, and the page never sees the private key or the project's cookies. The forward sends only the one Console route of a project, `POST /_vitehub/rpc`. It stops at a redirect and refuses a body that is larger than a 9 MiB file as base64, plus 64 KiB.

Forwarded responses use a Console-owned sandbox policy, `nosniff`, and attachment disposition. JSON keeps its media type; other bodies use `application/octet-stream`. The client can read JSON and binary data, while project content cannot run as a document or script on the Console origin.

## Accounts and teams

Sign-in uses Better Auth with `authDatabase()`, `organization()`, and `passkey()` from `@better-auth/passkey`. A team is a Better Auth organization.

- **GitHub**: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The callback URL of the GitHub OAuth app is `<console origin>/api/auth/callback/github`. Without them, the sign-in page offers passkeys only.
- **Passkeys**: the first passkey makes the account, with the name the person types. Such an account has no email address. Its email is a placeholder on the reserved `passkey.invalid` domain, so it cannot accept an invitation until the person signs in with GitHub. A signed-in person adds passkeys and GitHub from the account menu.
- **Teams**: every session opens a team. The first sign-in makes a personal team with the person as `owner`. Owners and admins link and unlink projects and invite people. Members open the projects. An invitation is a link to `/invite/<id>` for the email of a GitHub account, valid for 48 hours. The Console sends no email.

The server keeps at least one passkey or linked GitHub account when a sign-in method is removed, including concurrent requests from other tabs. Apply the database migrations on each host: they enforce this rule in the same statement as the deletion.

## ViteHub MCP

The Console serves the ViteHub MCP on two addresses. MCP clients do not sign in on an address that answers without a token, so docs and account tools need two.

| Address | Sign-in | Tools |
| --- | --- | --- |
| `/mcp` | None. It answers `tools/list` without a token and advertises no OAuth metadata. | `list-pages` and `get-page`. Each call goes to the docs MCP at `https://vitehub.dev/mcp`. |
| `/mcp/account` | OAuth with the Console account. Without a token it answers `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/account"`. | The docs tools, and `list_apps`, `link_app`, `check_app`, `unlink_app`, `list_operations`, and `run_operation`. |

```sh
claude mcp add --transport http vitehub https://console.vitehub.dev/mcp/account
```

The client registers itself (Dynamic Client Registration), and the browser opens `/oauth`. There the person signs in with GitHub or a passkey and allows the client. `mcpOAuth()` in `server/auth.ts` adds Better Auth's `jwt()` and `oauthProvider()`. Their tables (`jwks`, `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`, and the others) are in the first migration.

The account tools act on the team that the person opened last in the Console, else their first team, and they keep the rules of the HTTP routes because they call the same code:

- `link_app` and `unlink_app` need the `owner` or `admin` role. `link_app` returns the variable line that the app must set, such as `VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<public key>`.
- `check_app` calls `project.get`, and `list_operations` returns the sections and operations of the app.
- The account tools call the app's Operations endpoint through the forward, signed with the key of the link for the person, with `surface: "mcp"` in the signed `x-vitehub-caller`. The Agent's access token never reaches the app. The app applies its MCP rules: it refuses operations with `mcp: false` (such as `documents.action`), runs the others with the `mcp` surface (so `content.save` needs `ifDigest`), and lists only those in `project.get`.
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
| `VITEHUB_CONSOLE_KEY_<NAME>` | Optional. The public key of a link to this Console from a Console, such as itself. See [Link the Console to itself](#link-the-console-to-itself). |

## Link the Console to itself

The Console is a ViteHub app with Comments and `console: true`, so you can comment on its pages and triage the comments in a Console, as with any app:

On Node (including Docker), first build and deploy with `VITEHUB_CONSOLE_PUBLIC_URL` set to the Console's own public URL, as in the VPS steps below. This configures the trusted origin for signed calls; setting it only when starting the server is too late.

1. Set `VITEHUB_CONSOLE_COMMENTERS` to your email, such as `wrangler secret put VITEHUB_CONSOLE_COMMENTERS --config .output/server/wrangler.json`. On the next page you open, the tools pill shows **Comments**.
2. In the Console, **Link an app** with the Console's own URL, such as `https://console.vitehub.dev`. The next page shows a line `VITEHUB_CONSOLE_KEY_CONSOLE_<ID>=<public key>`.
3. Set that line on the Console, such as `wrangler secret put VITEHUB_CONSOLE_KEY_CONSOLE_<ID> --config .output/server/wrangler.json`, then click **Check connection**.

A call through the link comes from the Console's server to its own public URL, signed like a call to any other app. Comments in the Console follow the same list: the person that the Console signs needs an email in `VITEHUB_CONSOLE_COMMENTERS`.

## Routes

The `/api/projects` routes and the forward need a session. They act on the session's active team, and a person who is not a member gets `403`.

| Route | Use |
| --- | --- |
| `GET /api/projects` | The projects of the team, with the public key of each link (`publicKey`) and its variable (`keyVariable`). |
| `POST /api/projects` | Owners and admins link a project: `{ "url": "https://app.example.com", "label": "Docs" }`. Answers `201` with the project, `400` for a URL that is not `https://` or is private, and `409` when the team already linked the URL. |
| `POST /api/projects/<id>/check` | Call `project.get` on the project. `linked` is `true` once the project has the public key. |
| `DELETE /api/projects/<id>` | Owners and admins unlink a project. Remove its variable from the project as well. |
| `/p/<id>/_vitehub/**` | The forward to the project's data routes. |
| `POST /mcp`, `POST /mcp/account` | The ViteHub MCP. `/mcp` needs no session; `/mcp/account` needs an OAuth access token instead of a session. |
| `GET /oauth` | The sign-in and consent page of MCP clients. It needs no session. |
| `GET /api/sign-in-methods` | `{ "github": true }` when GitHub sign-in is configured. |
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
