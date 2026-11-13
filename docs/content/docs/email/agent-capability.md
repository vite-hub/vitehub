---
title: Email capability
description: Let an Agent send plain-text email from an application-owned sender to allowed recipients.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-mail
---

`email()` gives an Agent one tool, `email_send`. It sends a plain-text message from a sender that your app sets, through the [Email primitive](/docs/email). Limit who it can write to with `recipients`. Add `policy` when a send needs approval or a check based on context.
For app code, read the [Email server API](/docs/email/server-api). For provider setup, read [Email configuration](/docs/email/configure).

::warning
An approved call can contact real people and cost provider money.
Start with a short `recipients` allowlist, `policy: 'require-approval'`, a provider test account, and an approved test recipient.
::

## Configure email sending

Set `from` to a sender that your provider allows.

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { email } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    email({
      from: 'support@example.com',
      recipients: [
        'customer@example.net',
        'owner@example.com',
      ],
      policy: 'require-approval',
    }),
  ],
})
```

## Agent-visible tool contract

The Agent sees this tool. The docs build reads it from the real Capability, with the recipient allowlist.

::agent-capability-tools{name="email"}
::

`email_send` takes exactly three fields.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | `string \| readonly string[]` | Yes | One address or a non-empty list. No address can be empty. |
| `subject` | `string` | Yes | A non-empty subject. |
| `text` | `string` | Yes | A non-empty plain-text body. Do not put credentials or other secrets in it. |

## How email sending works

The Capability takes `from` from your app config. It calls `send({ from, to, subject, text })` on the Email runtime and returns the `[error, sent]` result as it is.
Success means the provider accepted the message and returned an `id`. It does not prove the message reached, showed in, or was read in an inbox.

The model cannot set HTML, headers, attachments, `cc`, `bcc`, or reply-to.
The Capability checks only that recipient strings are not empty. The Email driver and provider own address syntax, sender authorization, and delivery rules.

> [!NOTE]
> ViteHub adds no limits on recipient count, text length, payload size, or send rate. Your provider owns those limits and can charge for each accepted recipient or message.

`email()` has no `mode` option, because Email has no read operation. The Capability always reports `mode: 'write'`, so inspection and policy tools can see the side effect.

## Handle failures without duplicate delivery

The Capability returns the Email primitive's `[error, sent]` result as it is, and does not retry. A delivery failure is the `error`. Its JSON has only `code`, `why`, `fix`, and `docs`, so the model does not see `cause`.

These failures happen before the Email driver runs, so no message went out:

| Failure | When it occurs |
| --- | --- |
| Invalid or missing `from` | `email()` rejects the Agent Definition when it is created. |
| Non-array `recipients`, or a blank, non-string, or sparse entry | `email()` rejects the Agent Definition when it is created. |
| Missing Email primitive | The Capability fails to load before the Agent Driver gets `email_send`. |
| Runtime handle without `send()` | The Capability fails to load before the Agent Driver gets `email_send`. |
| Empty `to`, `subject`, or `text` | The tool call fails before it calls the Email primitive. |
| Recipient outside `recipients` | Policy denies the whole tool call before it calls the Email primitive. |

After the Email primitive runs, handle each `EMAIL_*` code like this:

| Failure | What to do |
| --- | --- |
| `EMAIL_NOT_CONFIGURED` | The tool call throws. Set up Email with one provider. |
| `EMAIL_INVALID_MESSAGE` | Correct the message. Do not retry it unchanged. |
| `EMAIL_AUTHENTICATION` | Fix provider credentials or sender authorization before you retry. |
| `EMAIL_RATE_LIMITED` | Use your own backoff or queue policy. |
| `EMAIL_NETWORK` or `EMAIL_TIMEOUT` | Delivery is uncertain. The provider may have accepted the message, so check its delivery logs before you retry. |
| `EMAIL_PROVIDER_FAILED` | Check protected server logs and provider delivery records. Never show `cause` to the model. |

You can safely return the `why` and `fix` of an `EMAIL_*` error.
Provider failures stay in `cause` for server-side debugging only. They can contain addresses, credentials, or response content. Custom drivers must follow the same rule.

## Keep Dynamic Markdown application-owned

`email_send` sends plain text only, on purpose.
It does not turn model Markdown into HTML, because [`renderEmailMarkdown()`](/docs/email/server-api#compose-dynamic-markdown) expects trusted templates and does not sanitize HTML or trusted fragments.

For branded HTML, fill a trusted template in app code and call the Email primitive directly. Or expose a [Custom Capability](/docs/agents/capabilities/custom) that takes a few escaped template values.
Do not pass free model output into a trusted HTML fragment.

## Requirements

- Node.js 22.22 or later.
- Vite 8 or later and one provider (`resend` or `cloudflare-email`).
- The provider must allow the `from` address.
- Generated Agent routes get the Email runtime (`email` from `vite-hub/email/server`) only while the Email Vite plugin is on.

Set one built-in Email provider in the config. The server reads the credential on every send.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    email: {
      driver: 'resend',
      options: {
        apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      email: {
        driver: 'resend',
        options: {
          apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
        },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      email: {
        driver: 'resend',
        options: {
          apiKey: env({ secret: true, source: env.source('RESEND_API_KEY') }),
        },
      },
    }),
  ],
})
```
:::
::

Follow [Configure Resend](/docs/email/get-started#configure-resend), or pick `cloudflare-email` with the same `driver` option.
Keep credentials in Server Env or your host's secret store, and use an `env()` declaration without a default. Plain options and non-secret defaults go into build output. ViteHub rejects defaults on secrets. The Capability never shows credentials to the model.

## Security and approval

The Agent can send plain-text email from the `from` address. It cannot change the sender or read mail.

`recipients` is the allowlist of exact addresses the Agent can write to.
Every address in `email_send.to` must be on it. One address outside the list denies the whole call before the Email primitive runs, so ViteHub never sends a message to only some recipients.

```ts [server/agents/support.ts] fragment
email({
  from: 'support@example.com',
  recipients: [
    'customer@example.net',
    'owner@example.com',
  ],
})
```

ViteHub puts this list in the Capability metadata and the `email_send` tool description, so the Agent picks a valid address without guessing.

> [!WARNING]
> The list becomes part of the model context. Include only addresses the model may see.

Matching trims spaces around addresses and ignores case, but the provider gets the original address.
Aliases, display-name forms, and other variants count as different strings unless `recipients` lists them.
Set `recipients: []` to deny all sends. Leave `recipients` out when you limit recipients somewhere else.

The optional `policy` is a second check after the allowlist.
It cannot widen `recipients`. `policy: 'allow'` still denies an address outside the list, and `policy: 'require-approval'` asks only about addresses that passed it.
Without `policy`, allowed recipients send at once. A policy function gets `{ name, input }` and returns `'allow'`, `'deny'`, `'require-approval'`, or `'retryable-failure'`.

`'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. The message is sent only after approval.
Read [Runtime policy, approvals, and traces](/docs/agents/runtime-policy) before you allow sends without a person.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets `email_send` after the Email primitive loads. |
| Provider-backed | Gets `email_send` through the provider MCP bridge. Approval requests through the bridge use the same policy. |
| Custom-run-backed | `driver.run` gets `email_send` in `context.tools` and decides if and when to call it. |

## Verify email delivery

1. Start the Vite dev server.
2. Run `vitehub agent info --agent support --json`. Check that `tools` has an entry with `name: "email"`. With `recipients` set, check that `capabilities` has `{ id: "email", metadata: { recipients: [...] } }` with your addresses.
3. For the first send, use an approved test recipient and a test or sandbox provider account.
4. Approve the call. Check that the tool result has no error and a non-empty `id`. Then find the message in the provider delivery logs or the recipient's inbox.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `from` | `string` | Required | Non-empty sender for every message, set by your app. The provider still checks and authorizes it. |
| `recipients` | `readonly string[]` | `undefined` (no allowlist) | Exact recipient allowlist. Every `to` address must match. An empty list denies all sends. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (allowed recipients send) | Optional approval or authorization policy for `email_send`. Runs after the `recipients` check. |

## Related pages

- [Email primitive](/docs/email)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
