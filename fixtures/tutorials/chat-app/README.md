# Nuxt chat tutorial

A text chat app with ViteHub Agents, Nuxt, and `@vite-hub/ui`. The app owns its encrypted sign-in cookie, SQLite history, routes, and access checks. The default Driver streams a fixed reply without a network request or API key.

Read [Build an AI chat app with Nuxt and ViteHub](../../../docs/content/docs/agents/build-a-chat-app.md). The tutorial contains the full application files. `docs/test/chat-tutorial.test.ts` checks that those files match this fixture.

## Setup

Use Node.js 24.15 or newer and the repository's pinned pnpm through Corepack. Keep the fixture in this checkout. Its `workspace:*` packages come from this source revision, while third-party dependencies are pinned in `package.json` and the root lockfile.

From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run --cache --filter vite-hub... --filter @vite-hub/ui... build
cd fixtures/tutorials/chat-app
corepack pnpm run setup
corepack pnpm dev
```

Open `http://127.0.0.1:4318`. Read `CHAT_PASSWORD` from `.env` and sign in. Select New chat and send `Hello`. The reply is `Offline reply 1: Hello`.

`setup` creates random local credentials with file mode `0600`. It refuses to replace an existing `.env`. Nuxt loads `.env` in development. The production start command uses Node's `--env-file` option. Keep `.env` out of source control.

The Nuxt config sets `buildDir: ".nuxt"` so Nitro transforms the generated TypeScript. The pinned Nitro version skips TypeScript under `node_modules`, which contains Nuxt's default build directory.

## Check the app

From this directory:

```sh
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:journey
```

The store test checks owner isolation, stale-write rejection, deletion, and reopening SQLite. The journey test starts the built Node server on `127.0.0.1:4319`, uses random temporary credentials, signs in, streams a reply, reads saved history, stops and restarts the process, continues the conversation, cancels a reply, and deletes the chat. It checks rejected access and blocked generated Agent routes. It forces offline mode and removes its own temporary database. Port 4319 must be free.

Also check the browser. Send a message, refresh, and select another saved chat. Stop a long reply and reload saved history. It contains completed turns only. Tab through sign-in, chat selection, and the prompt. Resize to a phone width. A successful HTTP journey does not prove layout or keyboard behavior.

## Use a model

In `.env`, set `CHAT_MODE=model`, keep or change `CHAT_MODEL=openai/gpt-4.1-mini`, and set `AI_GATEWAY_API_KEY` to a Vercel AI Gateway key. Restart the server. Keep the key on the server. This path needs a network connection and a funded provider account. Input history and generated output can incur charges. Check current gateway model availability and pricing before use.

The model Driver allows one step, no automatic retry, at most 800 output tokens, and a 60-second application timeout. The app allows 20 sends per minute and two active replies in its one Node process. These are teaching limits, not a billing cap. Set a provider budget too. No model call is part of the tests.

## Node deployment and storage

The named target is a self-hosted Node.js server with one process and a persistent local disk. Build and run from this directory:

```sh
corepack pnpm build
corepack pnpm start
```

Keep `NITRO_HOST=127.0.0.1`. Use an SSH tunnel for personal access or an HTTPS reverse proxy. For a proxy, set `CHAT_ORIGIN` to its exact HTTPS origin, preserve the request Origin header, disable response buffering for `/api/chat`, and limit request bodies to 16 KiB. The HTTPS origin enables secure cookies. Set a private absolute `CHAT_DB_PATH`, such as `/var/lib/vitehub-chat/chat.sqlite`, on a persistent disk before the first deployment. Keep both secrets stable across restarts. Run the app as a user who owns that directory.

The app supports one owner with a high-entropy password. It has no account recovery, per-user membership, or session revocation list. Sign-out clears the current browser cookie. Rotating `CHAT_SESSION_SECRET` signs out all sessions; changing only `CHAT_PASSWORD` does not. Do not share the password to create a multi-user service. Before public registration, replace this small sign-in flow with [ViteHub Auth](https://vitehub.dev/docs/auth), use its checked user ID in every store call, and test access between two real users. Put login and request limits at the proxy when exposure requires them.

History holds at most 100 chats for the owner and 20 completed turns per chat. A prompt has at most 2,000 characters and an answer at most 20,000 characters. SQLite stores plain text, including prompts sent to the model. Restrict disk access and apply a retention policy appropriate to the data. Delete chat removes its row; it does not securely erase pages or backups. Local storage in the browser holds only the selected chat ID, which grants no access.

The database is separate from `.output`. Rebuilding does not delete it. Back it up while the server is stopped, including its WAL side files. Do not use ephemeral container storage, a serverless filesystem, network-mounted SQLite, or multiple app replicas with this example. Active-stream locks and rate limits are process-local. Generation does not resume after a process crash. Complete turns survive; in-flight turns do not.

## Cleanup

Stop the process first. Delete chats in the UI to remove individual histories. For a full local reset, remove this fixture's `.data`, `.output`, `.nuxt`, and `.vitehub` directories. Delete this fixture's `.env` only when you want to discard its credentials. A custom `CHAT_DB_PATH` needs separate cleanup. Revoke an AI Gateway key through the provider when it is no longer needed.
