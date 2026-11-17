---
title: Console sections
description: What each section of the ViteHub Console shows and changes, from Env and KV to Content and Schedules, and what each one never reads.
navigation.title: Sections
navigation.order: 10
navigation.group: Use the Console
icon: i-lucide-layout-list
---

The Console shows a section for each primitive that your app installs and that [`authorize`](/docs/console/access) allows for you: Auth, Env, Agents, Skills, Served skills, Channels, Usage, MCP client, Logs, Content, Comments, Blob, Databases, Email, KV, Cache, Rate Limits, Sandbox Tasks, Workspaces, Workflows, Queues and Schedules.

[Agents in the Console](/docs/console/agents) covers Agents, Skills and Usage, and [MCP client](/docs/console/mcp-client) covers its section.

## Data sections

| Section | Shows | Changes |
| --- | --- | --- |
| **Env** | Declared Server Env variables by source, with the provider, secret flag, and whether each is required or has a default. | Nothing. It reads no values or defaults, calls no providers and checks no credentials. `env: false` turns off Env and its section. |
| **KV** | Stores and keys, in pages of at most 200. A value loads only when you select its key, as text or formatted JSON, cut at 256 KiB. | Sets and deletes keys, except `vitehub:` keys. |
| **Cache** | Keys, tags and values when the app sets `cache`. | Deletes cached entries with `cache.delete`; `cache:read` only lists and reads. |
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

None of these use the Agent journal. Workflow and Queue show no run or message history, because ViteHub has no provider-independent contract for it yet. To run Schedules or list their runs, locally or with `--url`, use [`vitehub schedule`](/docs/cli/jobs#run-and-inspect-schedules).

## Content and people

| Section | Shows when | What it does |
| --- | --- | --- |
| **Content** | `server/content.ts` defines document collections. | [Saves drafts, publishes and restores revisions](/docs/content/console), as `content.can()` allows each user. |
| **Comments** | The app turns on [Comments](/docs/comments/configure#turn-comments-on-in-a-vitehub-app). | Lists the threads that people left on the app's pages. |
| **Channels** | The app has Agents. | Lists your Agents' Channels and threads, and each conversation with its attachments and runs, which you can [export](/docs/agents/channels#see-and-export-a-conversation) as Markdown or JSON. |
| **Served skills** | The app has `server/skills.ts`. | Lists the [Agent Skills that the app serves](/docs/console/skills#turn-skills-on-and-off), with a switch for each. |
| **Site access** | The app has [Auth](/docs/auth). | [Signs browsers in](/docs/console/site-access) to the app for you. |

An app without a document editor owner, such as Content, ships no document editor or media library code.

## Manage Connections

An app with [`connections`](/docs/connections) has a **Connections** section. It lists each Connection with its provider, status, account, and last refresh, and works in production without app Auth or `connections.management`.

1. **Connect** or **Reconnect** on an OAuth Connection calls `connections.connect` with your signed Console call. The app starts the sign-in for you and returns the provider URL.
2. The Console opens the provider in a new tab. You choose the account and approve the scopes.
3. The provider sends the browser to the app's callback, `/_vitehub/connections/callback`. The app exchanges the code and keeps the grant. The Console never sees a code or a token.
4. Close the tab. The list loads again when you come back to the Console.

**Revoke** calls `connections.revoke`, which revokes the grant at the provider and deletes it from the app. Activity names you as `user:<your Console user id>`.

| Operation | Kind | Use |
| --- | --- | --- |
| `connections.list` | read | List the Connections. |
| `connections.connect` | write | Return the provider URL of a new sign-in, valid for 10 minutes. |
| `connections.revoke` | destructive | Revoke the grant of a Connection. |

- The callback of a Console sign-in needs no app session and no `state` cookie, because the Console page and the app have different origins. The signed call that started it checked you, and the `state` works once, for 10 minutes.
- The provider must allow the callback URL of the app, such as `https://app.example.com/_vitehub/connections/callback`.
- API key and ChatGPT Connections show their status here. Set a key, or sign in with a ChatGPT plan, with [`vitehub connections`](/docs/connections/server-api#cli).

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
  "build": {
    "time": "2026-11-14T10:00:00.000Z",
    "commit": { "sha": "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f", "message": "feat: add the ferry schedule", "author": "Ada Lovelace", "branch": "main" }
  },
  "sections": ["env", "kv"],
  "operations": ["definitions.list", "documents.action", "env.get", "kv.delete", "kv.get", "kv.has", "kv.list", "kv.set", "media.action", "project.get", "sections.list"]
}
```

`project.get` tells a client what the project runs and what the caller may use, and every caller that passes Console access can read it. It lists only the sections and operations that the app installs and that `authorize` allows, so a read-only grant such as `"kv:read"` leaves out the writes. An operation that reads its section from the input, such as `documents.action`, is listed, and each call checks its section again.

`protocol` is the version of this answer, and a client stops at a protocol that it does not know. `name` is the `name` option of `vitehub`, or the `name` in `package.json` when unset. `vitehub` is the version of the `vite-hub` package that the app runs, such as `0.0.0-preview-4f9c2e1` for a pkg.pr.new build.

`build` is what the production build recorded: when it ran, and its Git commit with the first line of the message, the author name, and the branch. The Console shows it as **Last deploy** on Home and on the app Overview. CI variables come first, such as `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, and `WORKERS_CI_COMMIT_SHA`, and `git` in the project fills the rest. A build without Git records only the time, and `SOURCE_DATE_EPOCH` sets the time of a reproducible build. A development server sends no `build`. Every caller that may read `project.get` sees the commit message and the author name.

The Console page also gets `navigation`, the answer of `sections.list`, so it opens a project with one call. `vitehub project info` and MCP clients do not get it.
