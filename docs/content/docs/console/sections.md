---
title: Console sections
description: What each section of the ViteHub Console shows and changes, from Env and KV to Content and Schedules, and what each one never reads.
navigation.title: Sections
navigation.order: 10
navigation.group: Use the Console
icon: i-lucide-layout-list
---

The Console shows only the sections that the app installs and that [`authorize`](/docs/console/access) allows for you. The sections are Auth, Env, Agents, Skills, Served skills, Channels, Usage, MCP client, Logs, Content, Comments, Blob, Databases, Email, KV, Rate Limits, Sandbox Tasks, Workspaces, Workflows, Queues, and Schedules.

Every read goes through the RPC route. Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Data sections

| Section | Shows | Changes |
| --- | --- | --- |
| **Env** | Declared Server Env variables, filtered by source, with the provider, secret flag, and whether each is required or has a default. | Nothing. It does not read values or defaults, call providers, or check credentials. Change values in your deployment configuration. `env: false` turns off Env and its section. |
| **KV** | Stores and keys, in pages of at most 200. It fetches a value only when you select its key, as text or formatted JSON, cut at 256 KiB. | Sets and deletes keys with `kv.set` and `kv.delete`. It does not edit `vitehub:` keys. |
| **Blob** | Stores and pages of object metadata: at most 100 objects first, and 250 per request, with an optional pathname prefix. ViteHub objects under `_vitehub/`, such as Workspace history and Console attachments, are hidden until you select **Show ViteHub files**. | Uploads (up to 8 MiB) and deletes with `blob.put` and `blob.delete`. Object contents and provider URLs never reach the Console. |
| **Databases** | Found Definitions (the files that declare each resource), their source, definition mode, and table names. | Nothing. It does not connect to a database. |
| **Rate Limits** | Policies. | Reads or resets the counter of a key that you enter, with `rate-limit.peek` and `rate-limit.reset`. |

KV inspection calls the store's paginated `list`, `get`, and `has`, and Blob inspection calls only `list`. A KV value read is a JSON-body `POST`, so the key stays out of the URL. Listing and reading can still count as provider operations.

## Runtime sections

| Section | Shows | Changes |
| --- | --- | --- |
| **Schedules** | Schedule Definitions with their cron expression and time zone. | Runs a Definition that sets `manual: true`, when [`invoke`](/docs/console/agents#start-agent-invocations) is on. |
| **Sandbox Tasks**, **Workspaces**, **Workflows**, **Queues** | Definitions and their source. | Nothing. They start no runtime resources. |
| **Logs** | [Logs](/docs/logs) of Evlog: Explorer and Stream, with the selected event in the right inspector. | Nothing. `logs.list` returns the same data, and `pnpm vitehub logs list --level error --json` reads it. |

Workflow, Queue, and Schedule inspection do not use the Agent journal. Workflow and Queue do not show run or message history, because ViteHub does not yet have provider-independent contracts for that data. Use [`vitehub schedule`](/docs/development/cli#run-and-inspect-schedules) to run Schedules or list recorded runs, in development or on a deployment with `--url`.

## Content and people

- **Content** shows when `server/content.ts` defines document collections. It saves drafts, publishes, and restores revisions. `content.can()` decides what each user may do. See [Edit Content in the Console](/docs/content/console). An app without a document editor owner, such as Content, has no document editor or media library code.
- **Comments** shows when the app turns on [Comments](/docs/comments/configure#turn-comments-on-in-a-vitehub-app). It lists the threads that people left on the app's pages.
- **Channels** lists the Channels of your Agents, their threads, and each conversation with its attachments and the runs that answered. You can download a conversation as Markdown or JSON. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).
- **Served skills** shows when the app has `server/skills.ts`. It lists the [Agent Skills that the app serves](/docs/console/skills#turn-skills-on-and-off) to coding agents, with a switch for each one.
- **Site access** shows when the app has [Auth](/docs/auth). It signs browsers in to the app for you. See [Site access](/docs/console/site-access).

The Console has no Connections section. To connect a provider account, use [`vitehub connections`](/docs/connections) against the app. In production, it needs the Connections management API with your own `actor` policy: `connections: { management: { actor: './server/connections-actor.ts' } }`.

The Agents, Skills, and Usage sections are on [Agents in the Console](/docs/console/agents). The MCP client section is on [MCP client](/docs/console/mcp-client).

## Read the project

The `project.get` operation tells a client what the project runs and what the caller may use. Each section and each operation is one that the app installs and that `authorize` allows for the caller. A read-only grant, such as `"kv:read"`, leaves out the operations that change state. Every caller that passes Console access can read it.

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
  "operations": ["definitions.list", "documents.action", "env.get", "kv.delete", "kv.get", "kv.has", "kv.list", "kv.set", "media.action", "project.get", "sections.list"]
}
```

`protocol` is the version of this answer. A client stops when the protocol is one that it does not know. `vitehub` is the version of the `vite-hub` package that the app runs. An operation that reads its section from the input, such as `documents.action`, is in the list, and each call checks its section again.
