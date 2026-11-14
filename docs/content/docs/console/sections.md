---
title: Console sections
description: What each section of the ViteHub Console shows and changes, from Env and KV to Content and Schedules, and what each one never reads.
navigation.title: Sections
navigation.order: 10
navigation.group: Use the Console
icon: i-lucide-layout-list
---

The Console shows a section for each primitive that your app installs and that [`authorize`](/docs/console/access) allows for you: Auth, Env, Agents, Skills, Served skills, Channels, Usage, MCP client, Logs, Content, Comments, Blob, Databases, Email, KV, Rate Limits, Sandbox Tasks, Workspaces, Workflows, Queues and Schedules.

[Agents in the Console](/docs/console/agents) covers Agents, Skills and Usage, and [MCP client](/docs/console/mcp-client) covers its section.

## Data sections

| Section | Shows | Changes |
| --- | --- | --- |
| **Env** | Declared Server Env variables by source, with the provider, secret flag, and whether each is required or has a default. | Nothing. It reads no values or defaults, calls no providers and checks no credentials. `env: false` turns off Env and its section. |
| **KV** | Stores and keys, in pages of at most 200. A value loads only when you select its key, as text or formatted JSON, cut at 256 KiB. | Sets and deletes keys, except `vitehub:` keys. |
| **Blob** | Object metadata per store, 100 objects first and 250 per request, with an optional pathname prefix. Objects under `_vitehub/`, such as Workspace history and Console attachments, stay hidden until you select **Show ViteHub files**. | Uploads up to 8 MiB and deletes. Object contents and provider URLs never reach the Console. |
| **Databases** | Found Definitions, with their source, definition mode and table names. | Nothing. It never connects to a database. |
| **Rate Limits** | Policies. | Reads or resets the counter of a key that you enter. |

KV inspection calls the store's paginated `list`, `get` and `has`, and Blob inspection only `list`, so both can count as provider operations.

## Runtime sections

| Section | Shows | Changes |
| --- | --- | --- |
| **Schedules** | Schedule Definitions with their cron expression and time zone. | Runs a Definition that sets `manual: true`, when [`invoke`](/docs/console/agents#start-agent-invocations) is on. |
| **Sandbox Tasks**, **Workspaces**, **Workflows**, **Queues** | Definitions and their source. | Nothing. They start no runtime resources. |
| **Logs** | [Evlog logs](/docs/logs) in Explorer and Stream, with the selected event in the right inspector. | Nothing. `pnpm vitehub logs list --level error --json` reads the same data through `logs.list`. |

None of these use the Agent journal. Workflow and Queue show no run or message history, because ViteHub has no provider-independent contract for it yet. To run Schedules or list their runs, locally or with `--url`, use [`vitehub schedule`](/docs/development/cli#run-and-inspect-schedules).

## Content and people

| Section | Shows when | What it does |
| --- | --- | --- |
| **Content** | `server/content.ts` defines document collections. | [Saves drafts, publishes and restores revisions](/docs/content/console), as `content.can()` allows each user. |
| **Comments** | The app turns on [Comments](/docs/comments/configure#turn-comments-on-in-a-vitehub-app). | Lists the threads that people left on the app's pages. |
| **Channels** | The app has Agents. | Lists your Agents' Channels and threads, and each conversation with its attachments and runs, which you can [export](/docs/agents/channels#see-and-export-a-conversation) as Markdown or JSON. |
| **Served skills** | The app has `server/skills.ts`. | Lists the [Agent Skills that the app serves](/docs/console/skills#turn-skills-on-and-off), with a switch for each. |
| **Site access** | The app has [Auth](/docs/auth). | [Signs browsers in](/docs/console/site-access) to the app for you. |

An app without a document editor owner, such as Content, ships no document editor or media library code.

::note
The Console has no Connections section. Run [`vitehub connections`](/docs/connections) against the app instead. In production, that needs the Connections management API with your own `actor` policy: `connections: { management: { actor: './server/connections-actor.ts' } }`.
::

## Read the project

```bash [Terminal]
pnpm vitehub project info
pnpm vitehub project info --url https://app.example.com
```

```json [Output]
{
  "protocol": 1,
  "name": "my-app",
  "vitehub": "0.1.0",
  "sections": ["env", "kv"],
  "operations": ["definitions.list", "documents.action", "env.get", "kv.delete", "kv.get", "kv.has", "kv.list", "kv.set", "media.action", "project.get", "sections.list"]
}
```

`project.get` tells a client what the project runs and what the caller may use, and every caller that passes Console access can read it. It lists only the sections and operations that the app installs and that `authorize` allows, so a read-only grant such as `"kv:read"` leaves out the writes. An operation that reads its section from the input, such as `documents.action`, is listed, and each call checks its section again.

`protocol` is the version of this answer, and a client stops at a protocol that it does not know. `vitehub` is the version of the `vite-hub` package that the app runs.
