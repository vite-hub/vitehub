---
title: Move the Console from earlier releases
description: Replace removed Console options, such as auth app, Console Auth, the app MCP at /_vitehub/mcp, and console.databaseUrl, with what now does the same job.
navigation.title: Move from earlier releases
navigation.order: 41
navigation.group: Reference
icon: i-lucide-arrow-right-left
---

A build that sets a removed `console` option fails with `VITE_HUB_B0020`, and the message names the fix.

## Move from auth: "app" or Console Auth

Earlier releases let the app sign people in to the Console with `console: { auth: 'app' }`, a Console Auth config (`auth: { ... }` with a server file, GitHub, or Cloudflare Access), or a bearer token with `auth: 'token'`. These options are removed, and so are `console.origins`, `console.mcp`, `console.signInPage`, and `console.embed`. The app no longer serves `/_vitehub/mcp`, `/_vitehub/sign-in`, `/_vitehub/api/auth/**`, `/_vitehub/env/manage`, or OAuth discovery for the Console.

1. Remove `auth`, `origins`, `mcp`, and `signInPage` from the `console` options, or set `console: true`.
2. Move a check of the person to [`console.authorize`](/docs/console/access#write-authorize). It gets the `user` that the Console signed, and the `team` and role of that user. App Auth access routes, such as `/_vitehub/**` or `/**`, no longer cover `POST /_vitehub/rpc` and `GET /_vitehub/rpc?ticket=`: a signed call has no app session, a one-time link has its ticket as proof, and the route checks its own access. A build fails when an app route file, such as `server/routes/_vitehub/rpc.post.ts`, uses the same path.
3. Remove `consoleMcpOAuth()` from `server/auth.ts`. Keep `mcpOAuth()` when the app serves its [own MCP server](/docs/mcp).
4. Link the app in [console.vitehub.dev](/docs/console/get-started#link-a-deployed-app), and set the `VITEHUB_CONSOLE_KEY_<NAME>` line that it shows. Invite the people who used the app's Console to your team.
5. For the CLI, make a key with `vitehub secret console-key`, and replace `VITEHUB_CONSOLE_AUTHORIZATION`, `VITEHUB_CONSOLE_COOKIE`, and `CF_ACCESS_CLIENT_ID` with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. See [Signed requests](/docs/console/signed-requests).
6. Connect agents to the [ViteHub MCP](/docs/console/mcp) instead of `/_vitehub/mcp`.

Live Content editing, the Content page preview, Env management, and the Connections connect flow needed the app session, and are not in the Console.

## Move from the MCP of the app

Earlier releases served a Console MCP in each app, at `/_vitehub/mcp`, with OAuth from `consoleMcpOAuth()`. It is removed. Connect the agent to `https://console.vitehub.dev/mcp/account`, link the app in the Console, and remove `consoleMcpOAuth()` and `console.mcp` from the app.

## Move the Agent journal options

Earlier releases stored the Agent Invocation journal at `.vitehub/data/console.sqlite` and read `console.databaseUrl`, `console.observations`, `console.retention`, and `VITEHUB_CONSOLE_DATABASE_URL`. These options are removed. A build that sets one of them fails with `VITE_HUB_B0020`, and a server that sets `VITEHUB_CONSOLE_DATABASE_URL` fails with `AGENT_R1032`.

Set `agent: { invocations: { databaseUrl, observations, retention } }` and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` instead. To keep old records, set `databaseUrl` to the old file, or pass it to [`vitehub agent invocations`](/docs/agents/invocation-storage#inspect-and-maintain-from-the-cli) with `--database`.
