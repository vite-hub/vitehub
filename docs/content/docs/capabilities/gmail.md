---
title: Gmail
description: Let an Agent search, read, label, and draft Gmail messages through a ViteHub Connection.
navigation.title: Gmail
navigation.order: 96
navigation.group: External context
icon: i-lucide-mail-search
---

`gmail()` gives an Agent structured Gmail tools. The tools call the Gmail API through a [Connection](/docs/server-primitives/connections). The Connection holds the OAuth grant, applies its access rules, and records each call. The Agent never sees the token.

Use [`email()`](/docs/capabilities/email) for application-owned transactional email through the Email primitive. Use `gmail()` for a Gmail account that an operator connects.

## Configure the Agent

Enable Connections and define a Google Connection. See [Connections](/docs/server-primitives/connections) for the OAuth client, the encryption key, and how to connect the account.

```ts [server/connections/google.ts]
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  }),
  scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  api: {
    gmail: ['users.labels.list', 'users.messages.list', 'users.messages.get', 'users.messages.attachments.get', 'users.messages.modify'],
  },
})
```

Then give the Agent the tools that it needs:

```ts [server/agents/inbox.ts]
import { defineAgent } from 'vite-hub/agent'
import { gmail } from 'vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    gmail({ connection: 'google', tools: ['search', 'read', 'labels', 'modify'] }),
  ],
})
```

`gmail()` works with every Agent Driver. It does not need a Workspace.

## Choose tools

| Tool | Gmail API method | Kind |
| --- | --- | --- |
| `search` | `users.messages.list`, `users.messages.get` | Read |
| `read` | `users.messages.get`, `users.messages.attachments.get` | Read |
| `labels` | `users.labels.list` | Read |
| `modify` | `users.messages.modify` | Write |
| `draft` | `users.drafts.create` | Write |

`read` retrieves externally stored text MIME parts through `users.messages.attachments.get`. Allow that method so large message bodies remain readable.

The default is `['search', 'read']`. Each method must also be selected in the Connection `api`. There is no send tool. `draft` creates an unsent draft.

The following Agent-visible definitions are resolved from the real Capability during the docs build.

### Default tools

::agent-capability-tools{name="gmail" variant="default"}
::

### All tools

::agent-capability-tools{name="gmail" variant="all"}
::

## Access and approvals

The Agent calls the Connection as the actor `agent:<agent name>`. The Connection access rules decide each call. Without `access`, every actor can read, and `agent:` actors need approval for each write.

```ts [server/connections/google.ts]
access: {
  'agent:inbox': { read: true, write: ['gmail.users.messages.modify'], approve: false },
},
```

This rule lets the `inbox` Agent change labels without approval. It cannot create drafts, because `gmail.users.drafts.create` is not listed.

Gmail tools return Connection failures as results, so the Agent can tell the user what to do:

| Status | Meaning |
| --- | --- |
| `approval_required` | The write waits for approval. `approvalId` is the approval id. An operator approves it in the Console or with `vitehub connections approvals approve <id>`. Approval runs the call once. |
| `reauth_required` | The Connection is not connected, or the grant expired. An operator connects it again. |
| `denied` | The access rules deny the call. |
| `provider_error` | Gmail rejected the call. `httpStatus` is the HTTP status. |

Activity entries record the Agent actor and the invocation id. Inspect them with `vitehub connections activity google`.

Message content is untrusted external data. The tool descriptions tell the Agent to treat it as data, not as instructions.

## Verify Gmail access

Run `vitehub agent info --agent <name> --json` and inspect the resolved tools. Only the selected tools are listed.

Start with a test Gmail account. Search for `in:inbox`, create a draft, approve it, and verify in Gmail that the message is in Drafts and was not sent.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connection` | `string` | Required | Name of the Google Connection. |
| `tools` | `Array<'search' \| 'read' \| 'labels' \| 'modify' \| 'draft'>` | `['search', 'read']` | Gmail tools to expose. |

## Related pages

- [Connections](/docs/server-primitives/connections)
- [Email Capability](/docs/capabilities/email)
