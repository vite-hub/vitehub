---
title: Email
description: Let an Agent send plain-text email from an application-owned sender to allowed recipients.
navigation.title: Email
navigation.order: 95
navigation.group: Runtime primitives
icon: i-lucide-mail
---

`email()` gives an Agent one external side effect: the `email_send` tool sends a plain-text message from an application-owned sender.
The tool calls the configured [Email primitive](/docs/server-primitives/email). Restrict exact addresses with `recipients`, then add `policy` when delivery requires approval or contextual authorization.
The Email primitive page covers application code and provider setup. This page covers the Agent tool.

::warning
An approved call can contact real people and incur provider charges.
Start with a short `recipients` allowlist, `policy: 'require-approval'`, a provider test account, and an approved test recipient.
::

## Configure email sending

Set `from` to a sender that the configured provider authorizes.

```ts [server/agents/support.ts]
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

This configuration exposes the following tool contract. The docs build resolves it from the real Capability, including the configured recipient allowlist.

::agent-capability-tools{name="email"}
::

`email_send` accepts exactly three fields.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | `string \| readonly string[]` | Yes | One recipient address or a non-empty list. Every address must be non-empty. |
| `subject` | `string` | Yes | A non-empty subject. |
| `text` | `string` | Yes | A non-empty plain-text body. Do not include credentials or other secrets. |

## How email sending works

The Capability fixes `from` from application configuration. It calls `send({ from, to, subject, text })` on the Email runtime handle and returns the result unchanged.
A successful result means the active provider accepted the message and returned an `id`. It does not prove inbox delivery, display, or reading.

The model cannot set HTML, headers, attachments, carbon-copy recipients, blind-carbon-copy recipients, or reply routing through this tool.
The Capability checks that recipient strings are non-empty. The Email driver and provider still own mailbox syntax, sender authorization, and delivery rules.
ViteHub does not add recipient-count, text-length, payload-size, or send-rate limits beyond non-whitespace validation.
Your delivery provider owns those limits and may charge for every accepted recipient or message.

`email()` has no `mode` option because Email exposes no read operation. The Capability always reports `mode: 'write'` so inspection and policy tooling can identify the side effect.

## Handle failures without duplicate delivery

The Capability forwards the Email primitive result and error unchanged.
It does not retry.

Capability-owned validation and runtime failures happen before the Email driver runs, so these failures cannot have delivered a message:

| Failure | When it occurs |
| --- | --- |
| Invalid or missing `from` | `email()` rejects the Agent Definition during construction. |
| Non-array `recipients`, or a blank, non-string, or sparse entry | `email()` rejects the Agent Definition during construction. |
| Missing Email primitive | Capability resolution rejects before the Agent Driver receives `email_send`. |
| Runtime handle without `send()` | Capability resolution rejects before the Agent Driver receives `email_send`. |
| Empty `to`, `subject`, or `text` | Tool execution rejects before calling the Email primitive. |
| Recipient outside `recipients` | Policy denies the entire tool call before calling the Email primitive. |

After the Capability calls the Email primitive, handle the `EMAIL_*` ViteHub error code according to the delivery state:

| Failure | What to do |
| --- | --- |
| `EMAIL_NOT_CONFIGURED` | Configure the Email integration with one provider. |
| `EMAIL_AUTHENTICATION` | Fix provider credentials or sender authorization before retrying. |
| `EMAIL_RATE_LIMITED` | Apply an application-owned backoff or queue policy. |
| `EMAIL_NETWORK` or `EMAIL_TIMEOUT` | Treat delivery as uncertain. Check provider delivery logs before retrying, because the provider may already have accepted the message. |
| `EMAIL_PROVIDER_FAILED` | Inspect protected server logs and provider delivery records. Never expose `cause` to the model. |

ViteHub-produced `ViteHubError.message` values are safe to return from the public runtime.
ViteHub-wrapped provider failures remain in `cause` for protected server-side diagnostics and may contain addresses, credentials, or response content. Custom drivers must preserve the same rule.

## Keep Dynamic Markdown application-owned

`email_send` is plain-text-only by design.
It does not render model-authored Markdown into HTML because [`renderEmailMarkdown()`](/docs/server-primitives/email#compose-dynamic-markdown) accepts trusted templates and does not sanitize authored HTML or trusted fragments.

When a product needs branded HTML, compose a trusted template in application code and call the Email primitive directly, or expose a [Custom Capability](/docs/capabilities/custom-capabilities) with a narrow set of escaped template values.
Do not pass unrestricted model output into a trusted HTML fragment.

## Requirements

- The application must run on Node.js 24.15 or later.
- Email configuration requires Vite 8 or later and one configured provider (`resend` or `cloudflare-email`).
- The configured provider must authorize the `from` address.
- Generated Agent routes receive the Email runtime handle (`email` from `@vite-hub/email/server`) only while the Email Vite integration is active.

Configure one built-in Email provider in the preset. Runtime Env resolves the credential on the server for every send.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
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

Follow [Configure Resend](/docs/server-primitives/email#configure-resend), or select the `cloudflare-email` provider through the same `driver` option.
Keep credentials in Server Env or the deployment platform's secret store and reference them with an Env declaration without a default. Literal options and non-secret Env defaults are included in build output. ViteHub rejects defaults on declarations marked secret. The Capability never exposes runtime credentials to the model.

## Security and approval

The Agent can send plain-text email from the configured `from` address. It cannot change the sender, and it cannot read mail.

Use `recipients` as the allowlist of exact addresses the Agent may contact.
Every address in `email_send.to` must match the configured list. One address outside the list denies the entire call before the Email primitive runs, so ViteHub never partially sends a multi-recipient message.

```ts [server/agents/support.ts]
email({
  from: 'support@example.com',
  recipients: [
    'customer@example.net',
    'owner@example.com',
  ],
})
```

ViteHub includes this list in Capability metadata and the `email_send` tool description, so the Agent can select a valid address without guessing.
The list becomes part of the Agent's model context. Include only addresses that the model is allowed to see.

Matching trims surrounding whitespace and ignores letter case, but the Capability forwards the original address values to the Email provider.
Aliases, display-name forms, and other address variations remain different strings unless they appear explicitly in `recipients`.
Set `recipients: []` to deny all sends, or omit `recipients` when static recipient restriction belongs elsewhere.

The optional `policy` is an additional gate after this allowlist.
It cannot widen `recipients`: a configured `policy: 'allow'` still denies an address outside the list, while `policy: 'require-approval'` prompts only for an address that passed the list.
Without `policy`, allowed recipients send immediately. A policy function receives `{ name, input }` and can apply contextual authorization by returning `'allow'`, `'deny'`, `'require-approval'`, or `'retryable-failure'`.

`'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. The message is sent only after approval.
Read [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) before enabling unattended delivery.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `email_send` after the Email primitive resolves. |
| Provider-backed | Receives `email_send` through the provider MCP bridge. Approval requests raised through the bridge use the same policy. |
| Custom-run-backed | `driver.run` receives `email_send` in `context.tools` and decides whether and when to call it. |

## Verify email delivery

1. Start the Vite development server.
2. Run `vitehub agent info --agent support --json`. Confirm that `tools` contains an entry with `name: "email"`. When `recipients` is set, confirm that `capabilities` contains `{ id: "email", metadata: { recipients: [...] } }` with the expected addresses.
3. For the first delivery, use an approved test recipient and a test or sandbox provider account.
4. Approve the call, confirm the tool returns a non-empty `id`, then verify the same message in provider delivery logs or the recipient mailbox.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `from` | `string` | Required | Non-empty application-owned sender passed to every message. The provider still validates and authorizes it. |
| `recipients` | `readonly string[]` | `undefined` (no static allowlist) | Exact recipient allowlist. Every `to` address must match. An empty list denies all sends. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (allowed recipients send) | Optional approval or authorization policy for `email_send`. Runs after the `recipients` check. |

## Related pages

- [Email primitive](/docs/server-primitives/email)
- [Official capabilities](/docs/capabilities/official-capabilities)
- [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces)
