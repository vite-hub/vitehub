---
title: Gmail
description: Let an Agent search and read Gmail and create unsent drafts through a Google Connection.
navigation.title: Gmail
navigation.order: 196
navigation.group: Capabilities
icon: i-lucide-mail-search
---

`gmail()` lets an Agent search Gmail, read messages, and create unsent drafts. No tool can send.

Tools call the Gmail REST API through a Google [Connection](/docs/connections), ViteHub's link to an external account. It keeps the OAuth grant, checks access per call, and records activity. Only `fetch` is used, so it runs on Node and Workers with no Workspace, CLI, or Skill.

Use `gmail()` for a Gmail account your team owns, [`email()`](/docs/email/agent-capability) for transactional email through the Email primitive, and the [Gmail Channel](/docs/agents/gmail) to run an Agent on each new message and label it.

## Configure the Agent

::steps{level="3"}

### Define the Google Connection

Enable [Connections](/docs/connections/get-started#define-a-connection) and declare the Google client credentials in Env:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    connections: true,
    env: {
      server: {
        google: {
          clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
        },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    connections: true,
    env: {
      server: {
        google: {
          clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
        },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    connections: true,
    env: {
      server: {
        google: {
          clientId: env({ source: env.source('GOOGLE_CLIENT_ID') }),
          clientSecret: env({ secret: true, source: env.source('GOOGLE_CLIENT_SECRET') }),
        },
      },
    },
  })],
})
```
:::
::

Define a Connection with the `google()` preset. `gmail.readonly` covers search and read; `gmail.compose` covers drafts.

```ts [server/connections/google.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    clientId: () => useServerEnv().google.clientId,
    clientSecret: () => useServerEnv().google.clientSecret.unseal(),
  }),
  scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  api: { gmail: ['users.messages.list', 'users.messages.get', 'users.messages.attachments.get', 'users.drafts.create'] },
  access: {
    'agent:inbox': { read: true, write: ['gmail.users.drafts.create'] },
  },
})
```

The access key is `agent:<name>`. This rule allows reads and asks for approval before a draft; `approve: false` skips approval. The `api` list leaves out send and delete methods.

### Add the Capability

```ts [server/agents/inbox.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { gmail } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    gmail({ operations: ['search', 'read', 'draft'] }),
  ],
})
```

### Connect the account

Run `vitehub connections connect google`.

::

## Tools

| Tool | Operation | Connection Operation ids | Effect |
| --- | --- | --- | --- |
| `gmail_search` | `search` | `gmail.users.messages.list`, `gmail.users.messages.get` | read |
| `gmail_read` | `read` | `gmail.users.messages.get`, `gmail.users.messages.attachments.get` | read |
| `gmail_draft` | `draft` | `gmail.users.drafts.create`, and `gmail.users.messages.get` for a reply | write |

- `gmail_search` returns sender, recipients, subject, date, labels, and snippet. The default query is `in:inbox`.
- `gmail_read` returns headers, the decoded text body up to `maxChars` (downloading bodies Gmail stores as attachments), and attachment names.
- `gmail_draft` creates a plain-text draft from `to`, `subject`, and `body`, always with `sent: false`.

For a reply, set `replyTo` to a message id. The tool reads it and sets the thread id, `In-Reply-To`, `References`, and `Re: <original subject>`. Do not set `subject`; a different one fails.

These definitions come from the real Capability at docs build time.

### Default operations

::agent-capability-tools{name="gmail" variant="read"}
::

### With drafts

::agent-capability-tools{name="gmail" variant="draft"}
::

> [!WARNING]
> Message content is untrusted. The tool descriptions tell the Agent to treat it as data, not instructions.

## Access and approval

Requests go through the Connections client, whose [access rules](/docs/connections/configure#access-rules) control the Agent actor, such as `agent:inbox`. With `access` set, unlisted actors are denied. A listed actor needs `read: true` to read and a matching `write` entry for drafts.

| Agent rule | `gmail_draft` result |
| --- | --- |
| `write: ['gmail.users.drafts.create'], approve: false` | Creates the unsent draft. |
| `write: ['gmail.users.drafts.create']` | Saves an approval request and fails with `CONNECTIONS_APPROVAL_REQUIRED`. After approval in the Console or with `vitehub connections approvals approve <id>`, the saved request runs once. |
| No matching write | Fails with `CONNECTIONS_DENIED`. |

A reply draft reads the original first, so it needs read access. `read: false` denies reads before any Google request. Access rules limit calls; OAuth scopes limit the grant.

> [!WARNING]
> `gmail_draft` cannot send, but `gmail.compose` and `gmail.modify` allow sending. Set an `api` list, as above, so the Connection cannot use send methods.

## Activity

Every Google request, including reads and denied calls, is recorded as activity with the Agent actor, action id, result, and Invocation id. Pending approvals appear in the approval list. Activity never includes bodies, headers, or tokens. View it under **Connections** in the Console or with `vitehub connections activity google`.

## Verify Gmail access

1. `vitehub agent info --agent inbox --json` lists `gmail_search` and `gmail_read`, plus `gmail_draft` with `draft`.
2. On a test account, search `in:inbox` and create a draft.
3. Check that it stays in Drafts, unsent.
4. Check the Agent's activity entries.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connection` | `string` | `"google"` | Google Connection in `server/connections/`. |
| `operations` | `Array<"search" \| "read" \| "draft">` | `["search", "read"]` | Tools to expose. `"draft"` adds `gmail_draft`. |

## Migrate from `mode`

> [!WARNING]
> Breaking change: `gmail()` no longer uses the `gog` CLI, a Workspace, or a bundled Gmail Skill.

| Before | After |
| --- | --- |
| `gmail()` | `gmail()` |
| `gmail({ mode: 'draft' })` | `gmail({ operations: ['search', 'read', 'draft'] })` and a Connection write rule for `gmail.users.drafts.create` |
| `gog` OAuth client, keyring, and `GOG_KEYRING_PASSWORD` | A Google OAuth client in Server Env and a Connection in `server/connections/` |
| `gmail_auth` tool | Connect the account with `vitehub connections connect` |
| `workspace: { mode: 'write' }` for Gmail | Not required |

Remove the `gog` installation and its state directories afterwards.

## Related pages

- [Connections](/docs/connections)
- [Email Capability](/docs/email/agent-capability)
