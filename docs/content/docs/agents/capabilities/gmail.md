---
title: Gmail
description: Let an Agent search and read Gmail and create unsent drafts through a Google Connection.
navigation.title: Gmail
navigation.order: 196
navigation.group: Capabilities
icon: i-lucide-mail-search
---

`gmail()` gives an Agent structured tools to search Gmail, read messages, and create unsent drafts. The tools call the Gmail REST API through a Google [Connection](/docs/connections). The Connection holds the OAuth grant, checks access for each call, and records activity. No tool can send a message.

The Capability uses only `fetch`, so it runs on Node and Workers. It does not need a Workspace, a CLI, or a Skill.

Use [`email()`](/docs/email/agent-capability) for application-owned transactional email through the Email primitive. Use `gmail()` for an operator-owned Gmail account and structured Gmail tools. To run an Agent on each new message and label it, use the [Gmail Channel](/docs/agents/gmail).

## Configure the Agent

::steps{level="3"}

### Define the Google Connection

Enable [Connections](/docs/connections/get-started#define-a-connection) and define a Connection with the `google()` preset. `gmail.readonly` covers search and read. `gmail.compose` covers drafts.

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

The access key is `agent:<name>`. This rule allows reads and asks for approval before creating a draft. Set `approve: false` to allow that declared write without approval. The `api` selection excludes methods that send or delete messages.

### Add the Capability

```ts [server/agents/inbox.ts]
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

Open the Console, select **Connections**, and select **Connect** for `google`. Or run `vitehub connections connect google`.

::

## Tools

| Tool | Operation | Connection Operation ids | Effect |
| --- | --- | --- | --- |
| `gmail_search` | `search` | `gmail.users.messages.list`, `gmail.users.messages.get` | read |
| `gmail_read` | `read` | `gmail.users.messages.get`, `gmail.users.messages.attachments.get` | read |
| `gmail_draft` | `draft` | `gmail.users.drafts.create`, and `gmail.users.messages.get` for a reply | write |

`gmail_search` returns sender, recipients, subject, date, labels, and snippet for each message. The default query is `in:inbox`. `gmail_read` returns the headers, the decoded text body up to `maxChars`, and attachment names. Gmail stores large bodies as attachments; `gmail_read` fetches them. `gmail_draft` creates a plain-text draft with `to`, `subject`, and `body`. The result always has `sent: false`.

Set `replyTo` to a Gmail message id to create a reply draft. The tool reads that message and sets the thread id, `In-Reply-To`, `References`, and `Re: <original subject>`, so Gmail adds the draft to the thread. Omit `subject` for a reply. A different subject fails.

The following Agent-visible definitions are resolved from the real Capability during the docs build.

### Default operations

::agent-capability-tools{name="gmail" variant="read"}
::

### With drafts

::agent-capability-tools{name="gmail" variant="draft"}
::

Message content is untrusted external data. The tool descriptions tell the Agent to treat it as data, not instructions.

## Access and approval

Each Gmail request runs through the Connections client. Its [access rules](/docs/connections/configure#access-rules) govern the Agent actor, for example `agent:inbox`. When `access` is present, unlisted actors are denied. A listed actor needs `read: true` for reads and a matching `write` entry for drafts.

| Agent rule | `gmail_draft` result |
| --- | --- |
| `write: ['gmail.users.drafts.create'], approve: false` | Creates the unsent draft. |
| `write: ['gmail.users.drafts.create']` | Persists an approval and fails with `CONNECTION_APPROVAL_REQUIRED`. Approve it in the Console or with `vitehub connections approvals approve <id>`. Connections then executes the stored request once. |
| No matching write | Fails with `CONNECTION_DENIED`. |

A reply draft first reads the original message, so it also requires read access. Setting `read: false` denies reads before a provider request starts.

The access rules limit the calls. The OAuth scopes limit the grant. `gmail_draft` cannot send, but the `gmail.compose` and `gmail.modify` scopes also permit sending. Use an explicit `api` selection as shown above to keep send methods unavailable to that Connection.

## Activity

Each provider request is recorded as Connection activity, reads included. Entries contain the Agent actor, action id, outcome, and Invocation id. Denied calls are recorded. Pending approvals appear in Connections approval inspection. Activity does not include message bodies, headers, or tokens.
See activity in the Console under **Connections**, or run `vitehub connections activity google`.

## Verify Gmail access

Run `vitehub agent info --agent inbox --json` and inspect the resolved tools. The default lists `gmail_search` and `gmail_read`. With `draft`, it also lists `gmail_draft`.

Start with a test Gmail account. Search for `in:inbox`, create a draft, and make sure in Gmail that the message stays in Drafts and was not sent. Then check the activity entries for the Agent.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connection` | `string` | `"google"` | Name of the Google Connection in `server/connections/`. |
| `operations` | `Array<"search" \| "read" \| "draft">` | `["search", "read"]` | Tools to expose. `"draft"` adds `gmail_draft`. |

## Migrate from `mode`

This is a breaking change. `gmail()` no longer uses the `gog` CLI, a Workspace, or a bundled Gmail Skill.

| Before | After |
| --- | --- |
| `gmail()` | `gmail()` |
| `gmail({ mode: 'draft' })` | `gmail({ operations: ['search', 'read', 'draft'] })` and a Connection write rule for `gmail.users.drafts.create` |
| `gog` OAuth client, keyring, and `GOG_KEYRING_PASSWORD` | A Google OAuth client in Server Env and a Connection in `server/connections/` |
| `gmail_auth` tool | Connect the account in the Console or with `vitehub connections connect` |
| `workspace: { mode: 'write' }` for Gmail | Not required |

Remove the `gog` installation and its state directories after you migrate.

## Related pages

- [Connections](/docs/connections)
- [Email Capability](/docs/email/agent-capability)
