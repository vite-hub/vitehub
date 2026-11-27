---
title: Server Primitives
description: Choose storage, background work, or another server API for your Vite or Nuxt app.
navigation.title: Server Primitives
navigation.order: 5
navigation.group: Next steps
icon: i-lucide-server-cog
---

Server Primitives are APIs for storage, background work, auth, and other server features. Call them from routes, handlers, or jobs. Each package has its own configuration and server API.

Set up your app in [Installation](/docs/getting-started/installation), save and read a value in [your first Server Primitive](/docs/getting-started/first-server-primitive), then pick the feature your app needs below. Agents are optional.

## Pick the right primitive

| You need | Start with |
| --- | --- |
| Public, server, build-time, runtime, or secret env values | [Env](/docs/env) |
| Application users, sessions, Better Auth routing, or guarded app routes | [Auth](/docs/auth) |
| Provider accounts the app owns, with OAuth refresh, access rules, and call activity | [Connections](/docs/connections) |
| GitHub App tokens and GitHub, GitLab, or Forgejo access from one set of env names | [Forge](/docs/forge) |
| Request budgets spent before expensive server work starts | [Rate Limit](/docs/rate-limit) |
| Outbound transactional messages with provider-neutral delivery | [Email](/docs/email) |
| Named outbound destinations, such as Telegram or Teams, behind selected connectors | [Channels](/docs/channels) |
| Outbound app events to outside URLs with HMAC signatures, retries, and debouncing on [supported hosts](/docs/webhooks/hosts) | [Webhooks](/docs/webhooks) |
| Contact, feedback, or problem-report forms with a spam guard, validation, an inbox, and email | [Forms](/docs/forms) |
| Pinned team comments on live pages, with replies, resolution, and in-place Content text edits | [Comments](/docs/comments) |
| App translation with no message keys, collected for translators and served in each request locale | [i18n](/docs/i18n) |
| An app MCP server for tools, prompts, or resources in `server/mcp/`, protected with MCP OAuth | [MCP server](/docs/mcp) |
| Small values by key: settings, flags, cursors, or light state | [KV](/docs/kv) |
| Relational data, constraints, joins, migrations, or queryable history | [Database](/docs/database) |
| Uploads, generated artifacts, binary files, or object metadata | [Blob](/docs/blob) |
| Local-first synced tables with offline writes, data kept on reload, and the server as authority for every row | [Sync](/docs/sync) |
| Stored browser reads for a signed-in account that show the last server answer, then refresh | [Device](/docs/device) |
| Provider-backed browser sessions, screenshots, DOM inspection, or live handoff | [Browser](/docs/browser) |
| Persistent file-tree state, snapshots, diffs, rules, or sessions | [Workspace](/docs/workspace) |
| Collaborative Markdown editing, presence, and Workspace checkpoints | [Realtime](/docs/realtime) |
| Read-only retrieval from files, globs, GitHub, markdown, MCP, or custom loaders | [Source](/docs/source) |
| Parse, query, search, and serve content from Sources | [Content](/docs/content) |
| Editable Markdown, JSON, and YAML documents published from the Console to the site or pull requests | [CMS](/docs/cms) |
| Structured events with Evlog, and inspection of an existing log backend | [Logs](/docs/logs) |
| Background delivery that returns before work finishes | [Queue](/docs/queue) |
| Durable long-running work with provider-tracked run state | [Workflows](/docs/workflows) |
| Static cron output | [Schedule](/docs/schedule) |
| Isolated provider-managed execution | [Sandbox](/docs/sandbox) |
| Controlled Unix-like command sessions | [Shell](/docs/shell) |
| AI model request routing through a gateway such as Vercel AI Gateway, Cloudflare AI Gateway, OpenRouter, or Ollama | [AI Gateways](/docs/gateways) |
| What people type, matched to declared options for filters, search facets, and command palettes | [Choices](/docs/choices) |
| UI for people and Agents: ui-sdk parts, Agent-sent UI specs, and live pages Agents work on | [UI](/docs/ui) |

## Call a feature from a route

Most primitives use the same import on every host. The build connects it to the selected provider.

This example uses the Nitro or Nuxt app from Installation with KV turned on. Both serve the file at `PUT /api/settings`. Keep the explicit H3 imports when you copy it:

```ts [server/api/settings.put.ts]
import { defineEventHandler, readBody } from 'h3'
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

The route uses the configured KV driver. The [KV tutorial](/docs/kv/get-started) adds the configuration, a read after the write, and a request to run.

## Add a Definition when the feature needs one

A Queue needs a handler Definition, and a Database needs a schema Definition. Each tutorial shows the file to create. ViteHub finds these files in development and build.

See [Definition discovery](/docs/development/definition-discovery) for names, [File conventions](/docs/reference/file-conventions) for paths, and [Configuration](/docs/reference/config-options) for more options.

## Give an Agent a selected operation

Your server calls each feature directly. An Agent needs a Capability, a grant for one selected operation. The [KV capability](/docs/kv/agent-capability) gives access to stored values, and the [Workspace capability](/docs/workspace/agent-capability) gives access to files.

Add a Capability only when the Agent needs it, and set its scope, write mode, and approval policy for the task. [Capabilities](/docs/agents/capabilities) lists the operations and the constraints each supports.

## Choose a host

Your host sets the resources and limits behind an API. Pick a host in [Build and deploy](/docs/getting-started/build-and-deploy), then read the feature's Hosts page. Check the generated bindings and resource identities before you connect production data.
