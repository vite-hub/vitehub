# @vite-hub/console

The ViteHub Console as its own app. You deploy it once, sign in, and link your apps. The Console server calls each app's Operations endpoint with that app's token. Apps do not serve Console pages, need no CORS, and run no OAuth server for the Console.

This package is private and in progress. It has the server part: sign-in, the list of linked projects, and the forward to their Operations endpoint. The Console page and the `vite-hub console deploy` command come next.

## How it works

1. An admin links a project with its URL. The Console makes a token for the project. It keeps the token encrypted and shows only its SHA-256.
2. You add that hash to the project's `VITEHUB_CONSOLE_TOKEN_SHA256`. The project needs `console: { auth: "token" }`.
3. The Console page calls `/p/<project>/_vitehub/...` on the Console origin. The Console server sends the call to the project with `Authorization: Bearer <token>`.

The project never sees the cookies, `Origin`, or `Authorization` header of the Console page, and the page never sees the token or the project's cookies. The forward sends only the data routes: `/_vitehub/rpc/**`, `/_vitehub/api/**`, and `/_vitehub/page/session`. It stops at a redirect and refuses a body over 9 MiB.

Forwarded responses use a Console-owned sandbox policy, `nosniff`, and attachment disposition. JSON keeps its media type; other bodies use `application/octet-stream`. The client can read JSON and binary data, while project content cannot run as a document or script on the Console origin.

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

## Develop

```sh
corepack pnpm --dir packages/console exec vitehub db migrate
VITEHUB_CONSOLE_SECRET=$(openssl rand -hex 32) VITEHUB_CONSOLE_ALLOW_PRIVATE=true corepack pnpm --dir packages/console run dev
corepack pnpm --dir packages/console run test
```
