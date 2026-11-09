# @vite-hub/console

The ViteHub Console as its own app. You deploy it once, sign in, and link your apps. The Console server calls each app's Operations endpoint with that app's token. Apps do not serve Console pages, need no CORS, and run no OAuth server for the Console.

This package is private and in progress. It has the server part: sign-in, the list of linked projects, and the forward to their Operations endpoint. The Console page and the `vite-hub console deploy` command come next.

## How it works

1. An admin links a project with its URL. The Console makes a token for the project. It keeps the token encrypted and shows only its SHA-256.
2. You add that hash to the project's `VITEHUB_CONSOLE_TOKEN_SHA256`. The project needs `console: { auth: "token" }`.
3. The Console page calls `/p/<project>/_vitehub/...` on the Console origin. The Console server sends the call to the project with `Authorization: Bearer <token>`.

The project never sees the cookies, `Origin`, or `Authorization` header of the Console page, and the page never sees the token or the project's cookies. The forward sends only the data routes: `/_vitehub/rpc/**`, `/_vitehub/api/**`, and `/_vitehub/page/session`. It stops at a redirect and refuses a body over 9 MiB.

## Configure

| Variable | Use |
| --- | --- |
| `VITEHUB_CONSOLE_SECRET` | The key that encrypts project tokens, at least 32 characters. Create it with `openssl rand -hex 32`. If it changes, the Console cannot open the tokens, and you must link the projects again. |
| `VITEHUB_CONSOLE_ALLOW_PRIVATE` | `true` lets the Console link private addresses, such as `localhost`, `10.0.0.8`, or `*.internal`. Off by default, so a person who links a project cannot make the Console fetch an address in its own network. The check reads the host name: a public name that resolves to a private address passes it. |
| `VITEHUB_ADMINS` | GitHub accounts that get the admin role, such as `github:22072217`. See [Give the first admin role](https://vitehub.dev/docs/auth/configure#give-the-first-admin-role). |
| `VITEHUB_ADMIN_CLAIM` | A one-time claim code from `vitehub auth claim` for the first admin of an email and password account. |

Only users with the `admin` role can use the routes below. Others get `401` or `403`.

## Routes

| Route | Use |
| --- | --- |
| `GET /api/projects` | The linked projects, with the SHA-256 of each token. |
| `POST /api/projects` | Link a project: `{ "url": "https://app.example.com", "label": "Docs" }`. Answers `201` with the project, `400` for a URL that is not `https://` or is private, and `409` when the URL is already linked. |
| `POST /api/projects/<id>/check` | Call `project.get` on the project. `linked` is `true` once the project has the hash. |
| `DELETE /api/projects/<id>` | Unlink a project. Remove its hash from the project's `VITEHUB_CONSOLE_TOKEN_SHA256` as well. |
| `/p/<id>/_vitehub/**` | The forward to the project's data routes. |

## Deploy

`vite-hub console deploy` will run these steps for you. Until it ships, run them from `packages/console`. Each host keeps the Console's data in its own database, so run the same steps again to update.

| Host | Database | Limits |
| --- | --- | --- |
| VPS (Node, Docker) | SQLite in `/data`, migrated when the server starts | You run TLS, such as Caddy. It can link apps on a private network with `VITEHUB_CONSOLE_ALLOW_PRIVATE=true`. |
| Cloudflare Workers | D1 | Cannot reach private addresses. The build sets `global_fetch_strictly_public`, without which a Worker that fetches another Worker on the same zone gets error 1042. |
| Vercel | Hosted libSQL, such as Turso from the Vercel Marketplace | Request bodies stop at 4.5 MB, so Blob and Media uploads above that fail through the Console. Cannot reach private addresses. |

### VPS with Docker

```sh
VITEHUB_DATA_DIR=/data vp build
export BETTER_AUTH_URL=https://console.example.com BETTER_AUTH_SECRET=$(openssl rand -hex 32) VITEHUB_CONSOLE_SECRET=$(openssl rand -hex 32)
pnpm exec vitehub auth claim    # prints the code once, and the VITEHUB_ADMIN_CLAIM value to export
docker compose up -d --build
```

Keep `VITEHUB_CONSOLE_SECRET` in a password manager: without it, the Console cannot open the project tokens. The `console-data` volume holds the database. Without Docker, run `node .output/server/index.mjs` with the same variables. The build writes the database path, so build with the `VITEHUB_DATA_DIR` that the server uses. The output holds the native libSQL module of the build machine, so build on the CPU architecture of the server, such as x64 or arm64.

### Cloudflare

```sh
wrangler d1 create vitehub-console    # note the database id
VITEHUB_HOSTING=cloudflare VITEHUB_CONSOLE_D1_ID=<id> vp build
wrangler d1 migrations apply DB --remote --config .output/server/wrangler.json
wrangler secret put VITEHUB_CONSOLE_SECRET --config .output/server/wrangler.json   # and BETTER_AUTH_SECRET, VITEHUB_ADMIN_CLAIM
wrangler deploy --config .output/server/wrangler.json
```

### Vercel

Add a Turso database from the Vercel Marketplace to the project, so the project has `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Then:

```sh
VITEHUB_HOSTING=vercel TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... vitehub db migrate
VITEHUB_HOSTING=vercel vp build
vercel env add VITEHUB_CONSOLE_SECRET    # and BETTER_AUTH_SECRET, BETTER_AUTH_URL, VITEHUB_ADMIN_CLAIM
vercel deploy --prebuilt --prod
```

## Develop

```sh
corepack pnpm --dir packages/console exec vitehub db migrate
VITEHUB_CONSOLE_SECRET=$(openssl rand -hex 32) VITEHUB_CONSOLE_ALLOW_PRIVATE=true corepack pnpm --dir packages/console run dev
corepack pnpm --dir packages/console run test
```
