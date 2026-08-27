---
title: Console
description: Enable the Agent invocation console, protect its routes, and understand its storage limits.
navigation.order: 32
icon: i-lucide-monitor-dot
---

The ViteHub Console is a read-only app for inspecting discovered Agents and retained Agent Invocations. It is off by default. Enable it, start the app, then open `/_vitehub` to browse sessions, search retained text, and inspect invocation events.

Console data can contain user prompts, model output, tool activity, and provider metadata. Protect the Console before making it reachable on a production URL.

## Enable the Console

Set `console: true` in the root ViteHub integration during development. Production builds require an explicit access contract described below.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: true,
    preset: 'node',
  })],
})
```

A standalone Nitro 3 app adds Nitro after ViteHub. The Console app and its UI dependencies ship inside `vite-hub`, so an existing Nitro app does not need another Console or UI package.

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vitehub({
      agent: true,
      console: true,
      preset: 'node',
    }),
    nitro(),
  ],
})
```

Nuxt uses the same option. Install Nuxt UI because the Console uses the ViteHub UI module.

```bash [Terminal]
pnpm add @nuxt/ui
```

```ts [nuxt.config.ts]
import viteHubNuxt from 'vite-hub/nuxt'

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, {
      agent: true,
      console: true,
      preset: 'node',
    }],
  ],
})
```

Restart the development server after changing the option. Open `http://localhost:3000/_vitehub`, using your app's actual origin and port.

If `console` is omitted or set to `false`, ViteHub does not register a Console page, API handler, Nitro plugin, or public asset path. A disabled Console returns the host's normal not-found response.

## Develop against a fixture

Use `vitehub console dev` when Console work needs the same Agent Invocations on every restart. The command validates a versioned JSON fixture, then starts the development command after `--` with an in-memory Console journal. It does not write `.vitehub/data/console.sqlite`.

```bash [Terminal]
pnpm vitehub console dev \
  --fixture test/fixtures/console.fixture.json \
  -- pnpm dev
```

Fixture paths resolve from the Vite project root. Put records in oldest-to-newest order so the generated journal cursors produce the expected newest-first session list. A version 1 fixture contains complete `AgentInvocationRecord` values. `cursor` is optional because fixture mode assigns one from the array order.

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

The wrapper preserves the child command's exit status. Invalid arguments, unreadable files, malformed JSON, unsupported fixture versions, duplicate invocation ids, and invalid records print a diagnostic to stderr and return status `1` without starting the development command. Fixture mode is development-only, and a production build rejects the fixture environment before it generates server output.

Fixtures often contain prompts and model output. Use synthetic or scrubbed records before committing them.

## Protect both route groups

The Console registers the page under `/_vitehub/**` and its read API under `/api/_vitehub/console/**`. A production build rejects bare `console: true` so these inspection routes cannot be exposed accidentally.

If the app uses ViteHub Auth, set `console: { access: 'auth' }` and guard both route groups in the Primary Auth Definition. The host decides what makes a user an administrator.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    auth: true,
    console: { access: 'auth' },
    preset: 'node',
  })],
})
```

```ts [server/auth.ts]
import { defineAuth, type AuthAccessAuthorize } from 'vite-hub/auth'

const authorizeConsole: AuthAccessAuthorize = ({ user }) =>
  user.role === 'admin'

export default defineAuth({
  access: {
    routes: [
      { route: '/_vitehub/**', authorize: authorizeConsole },
      { route: '/api/_vitehub/console/**', authorize: authorizeConsole },
    ],
  },
})
```

ViteHub checks for an Auth Session before it calls `authorizeConsole`. A missing session returns `401`. Returning `false` from the callback returns `403`. The callback can return a `Response` when the app needs another rejection or redirect.

The `role` field above is an application example, not a ViteHub field. Replace it with the role, permission, or allowlist already used by the host.

Apps that use another authentication library must protect both route groups in host middleware and acknowledge that boundary explicitly:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    console: { exposure: 'host-managed' },
    preset: 'node',
  })],
})
```

`host-managed` is an acknowledgement, not middleware. ViteHub does not inspect or enforce the host's access policy in this mode.

Read [Auth](/docs/server-primitives/auth#authorize-access-routes) for sign-in redirects and the complete callback contract.

## Know what the Console stores

The Console installs a fallback Agent Invocation journal at `.vitehub/data/console.sqlite`. It retains invocation records and selected searchable text, including prompts, messages, final text, and progress updates.

Set `VITEHUB_CONSOLE_DATABASE_URL` when the journal belongs on another volume or libSQL endpoint. Relative `file:` paths resolve from the ViteHub project root:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=file:/var/lib/my-app/console.sqlite
```

Authenticated libSQL endpoints also require `VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN`:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=libsql://my-database.turso.io
VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN=secret-token
```

The journal has no automatic TTL or deletion. In production, the operator must define how long to retain the file and how to remove records that may contain sensitive data.

The fallback applies only when an Agent Definition does not configure `invocations`. An explicit `defineAgent({ invocations })` store remains authoritative, and its sessions are not copied into `console.sqlite` or read by the built-in Console.

The automatic fallback also requires `defineAgent` from `vite-hub/agent`. Definitions imported directly from `@vite-hub/agent` must configure their own `invocations` store. Use the [Invocation UI](/docs/ui/invocation) with that store when the app needs a custom inspection page.

Production Console builds currently require `preset: 'node'` because the fallback journal uses local SQLite. The Node preset supports the build, but it does not make `.vitehub/data/console.sqlite` persistent: the host must provide durable storage that survives process and deployment replacement. The file is also local to one replica and is not shared across replicas. Other presets can run the Console during development. Their production builds fail while Console is enabled, so ViteHub does not write the journal to storage that may disappear between requests or deployments.

The Console API accepts `GET` requests only. Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Inspect usage

Session details show recorded token totals when the invocation trace contains provider usage. Add the [Usage Capability](/docs/capabilities/usage) when the provider needs an explicit usage request or the Agent must expose the normalized Agent Usage Record at finish.

The Console does not calculate missing provider data. Token counts, model metadata, and provider-reported cost remain absent when the provider does not report them.

## Fix common failures

| Symptom | Check |
| --- | --- |
| `/_vitehub` returns `404` | Confirm `console: true`, then restart the development server. Omitted and false configurations register no route. |
| The Console opens but has no sessions | Invoke a discovered Agent. Confirm it uses the framework fallback instead of a separate `invocations` store. |
| A production build rejects `console: true` | Use `console: { access: 'auth' }` with callback-backed policies for both route groups, or acknowledge host middleware with `console: { exposure: 'host-managed' }`. Production also requires the Node preset. |
| The page returns `401` | Sign in through the Auth provider configured by the host. |
| The page returns `403` | Check the host's `authorize` callback and the current user's role or permission. |

Use [Agent Invocations](/docs/agents/invocations) for custom stores and invocation lifecycle behavior. Use [Invocation UI](/docs/ui/invocation) when building an application-owned inspection page instead of mounting the complete Console.
