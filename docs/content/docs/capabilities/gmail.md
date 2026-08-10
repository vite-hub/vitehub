---
title: Gmail
description: Let a Harness Agent search Gmail and create unsent drafts through structured tools.
navigation.title: Gmail
navigation.order: 96
navigation.group: External context
icon: i-lucide-mail-search
---

`gmail()` gives a Harness Agent structured Gmail search and authorization tools. Draft mode adds draft creation, but the Capability never exposes a send tool or registers the underlying `gog` executable on `bash`.

Use [`email()`](/docs/capabilities/email) when an Agent should send application-owned transactional email through the Email primitive. Use `gmail()` when a Harness Agent should work with an operator-owned Gmail account through structured Gmail tools.

## Configure the Agent

Install [`gog`](https://github.com/openclaw/gogcli) in the Box environment, configure its Google OAuth client, and keep its writable authentication state in Box Home. The application owns this setup; the Capability never accepts OAuth client secrets or keyring passwords as tool input.

```ts [server/agents/inbox.ts]
import { defineAgent } from '@vite-hub/agent'
import { gmail } from '@vite-hub/agent/capabilities'

export default defineAgent({
  box: {
    runtime: {
      kind: 'trusted-host',
      stateRoot: '/var/lib/vitehub/boxes',
    },
    env: {
      GOG_KEYRING_BACKEND: 'file',
      GOG_KEYRING_PASSWORD: () => process.env.GOG_KEYRING_PASSWORD,
    },
    home: {
      state: {
        '.config/gogcli': { key: 'inbox-agent/gmail-config' },
        '.local/share/gogcli': { key: 'inbox-agent/gmail-data' },
      },
    },
    requires: ['gog'],
  },
  capabilities: [
    gmail({ mode: 'draft' }),
  ],
  driver: 'codex',
  workspace: {
    mode: 'write',
  },
})
```

Use an absolute, operator-owned `stateRoot` in production and stable project-qualified Home state keys. Current [`gog` path conventions](https://github.com/openclaw/gogcli/blob/main/docs/paths.md) keep configuration in `.config/gogcli` and OAuth metadata plus file-keyring entries in `.local/share/gogcli` on Linux, so persist both paths. Supply `GOG_KEYRING_PASSWORD` through Server Env or the deployment secret store. Follow the [`gog` OAuth client setup](https://github.com/openclaw/gogcli/blob/main/docs/quickstart.md) before the first authorization attempt.

## Choose a mode

Read mode is the default and exposes two tools:

| Tool | Behavior |
| --- | --- |
| `gmail_auth` | Starts or completes remote authorization for one Gmail address. |
| `gmail_search` | Searches or lists Gmail threads. It does not retrieve full message bodies. |

Draft mode exposes the same tools plus `gmail_draft`, which creates an unsent draft with `to`, optional `cc` and `bcc`, a subject, and a plain-text body.

```ts
gmail()
gmail({ mode: 'draft' })
```

`gmail()` has no send mode. Search commands run with read-only and no-send controls. Draft creation runs with `--gmail-no-send`, and no Capability-owned tool can send the resulting draft.

This is a Capability tool-surface contract, not a security boundary around the Harness. A Harness Agent can execute commands inside its Box, including an installed `gog`, so use draft mode only when the Agent is trusted not to bypass the structured tools. If sending must be impossible, isolate the credential behind a runtime or provider policy that cannot send; `gmail()` does not provide that isolation.

## Complete authorization

Gmail tools return authorization as structured states instead of asking the user to run shell commands:

| Status | Next action |
| --- | --- |
| `account_required` | Ask which Gmail address to use, then retry the original tool with `account`. |
| `authorization_required` | Send `authorizationUrl` to the user. Google may redirect to a localhost page that does not load; collect the full browser address-bar URL. |
| `connected` | Retry the original Gmail tool. |
| `configuration_required` | The operator must configure the OAuth client using `setupUrl`. Do not request secrets in chat. |

Complete a pending redirect through `gmail_auth`:

```ts [Agent tool call]
await gmail_auth({
  action: 'complete',
  account: 'owner@example.com',
  redirectUrl: 'http://localhost:8080/?code=...&state=...',
})
```

The Capability accepts only an HTTP loopback URL with both `code` and `state`. It exchanges the URL inside the Box and does not return it in the result.

## Runtime boundaries

`gmail()` requires all of the following:

- A Harness Agent Driver.
- An explicit Workspace with `workspace.mode: 'write'`, because each structured Gmail call opens a Box-backed writable Workspace Session.
- `defineAgent({ box })` with `gog` available.
- Operator-owned OAuth client configuration and persistent Box Home state.

Each underlying `gog` command opens its own Workspace Session and closes the Session on success or failure. Gmail search results remain untrusted external content and the contributed `skills/gmail/SKILL.md` tells the Harness Agent to treat them as data, not instructions.

Draft authorization may grant the Gmail account scope that `gog` needs to create drafts. The no-send contract applies only to the Capability-owned tools and their command flags; it does not restrict the Harness's own Box command authority.

## Inspect and verify

Run `vitehub agent info --agent <name> --json` and inspect the resolved tools. Read mode should list only `gmail_auth` and `gmail_search`; draft mode should add only `gmail_draft`.

Start with a test Gmail account. Search for `in:inbox`, create a draft in draft mode, and verify in Gmail that the message remains in Drafts and was not sent.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "draft"` | `"read"` | Exposes search and authorization tools, with draft creation added only in draft mode. |

## Reference

- [Boxes](/docs/agents/boxes)
- [Workspace shell](/docs/capabilities/workspace-shell)
- [Email Capability](/docs/capabilities/email)
- Source: `packages/agent/src/capabilities/gmail.ts`
