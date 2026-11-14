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

Apps no longer sign people in to the Console. `console: { auth: 'app' }`, Console Auth (`auth: { ... }` with a server file, GitHub or Cloudflare Access), `auth: 'token'`, `console.origins`, `console.mcp`, `console.signInPage` and `console.embed` are removed, and so are `/_vitehub/mcp`, `/_vitehub/sign-in`, `/_vitehub/api/auth/**`, `/_vitehub/env/manage` and the Console's OAuth discovery.

1. Remove `auth`, `origins`, `mcp` and `signInPage` from `console`, or set `console: true`.
2. Move checks of the person to [`console.authorize`](/docs/console/access#write-authorize), which gets the signed `user` and their `team` and role.
3. Remove `consoleMcpOAuth()` from `server/auth.ts`. Keep `mcpOAuth()` if the app serves its [own MCP server](/docs/mcp).
4. [Link the app](/docs/console/get-started#link-a-deployed-app), set the `VITEHUB_CONSOLE_KEY_<NAME>` line, and invite the app's Console users to your team.
5. For the CLI, replace `VITEHUB_CONSOLE_AUTHORIZATION`, `VITEHUB_CONSOLE_COOKIE` and `CF_ACCESS_CLIENT_ID` with a [`VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`](/docs/console/signed-requests) from `vitehub secret console-key`.
6. Connect agents to the [ViteHub MCP](/docs/console/mcp) instead of `/_vitehub/mcp`.

App Auth access routes such as `/_vitehub/**` or `/**` no longer cover `POST /_vitehub/rpc` and `GET /_vitehub/rpc?ticket=`, because a signed call has no app session, a one-time link carries its ticket, and the route checks its own access. An app route file on the same path, such as `server/routes/_vitehub/rpc.post.ts`, fails the build.

Live Content editing, the Content page preview, Env management and the Connections connect flow needed the app session, so they are not in the Console.

## Move from the MCP of the app

The per-app Console MCP at `/_vitehub/mcp`, with OAuth from `consoleMcpOAuth()`, is removed. Connect the agent to `https://console.vitehub.dev/mcp/account`, link the app in the Console, and remove `consoleMcpOAuth()` and `console.mcp`.

## Move the Agent journal options

`console.databaseUrl`, `console.observations` and `console.retention` now fail the build with `VITE_HUB_B0020`, and `VITEHUB_CONSOLE_DATABASE_URL` fails the server with `AGENT_R1032`. Set `agent: { invocations: { databaseUrl, observations, retention } }` and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` instead. The old journal lived at `.vitehub/data/console.sqlite`: to keep its records, set `databaseUrl` to that file, or pass it to [`vitehub agent invocations`](/docs/agents/invocation-storage#inspect-and-maintain-from-the-cli) with `--database`.
