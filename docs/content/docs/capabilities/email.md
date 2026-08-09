---
title: Email
description: Let an Agent send authorized plain-text email through the configured Email primitive.
navigation.title: Email
navigation.order: 95
navigation.group: Runtime primitives
icon: i-lucide-mail
---

`email()` grants an Agent one external side effect: `email_send` sends a plain-text message from an application-owned sender through the configured ViteHub Email primitive.
Attach it only when the Agent should contact external recipients, scope exact addresses with `recipients`, then use policy when delivery requires approval or contextual authorization.

::warning
An approved call can contact real people and incur provider charges.
Start with a short `recipients` allowlist, `policy: 'require-approval'`, a provider test account, and an approved test recipient.
::

## Configure the Email primitive first

Enable Email Definition discovery in the ViteHub preset and add one `server/email.ts` or `server.email.ts`.
The Definition owns the delivery driver, provider credentials, and sender authorization.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: "node", email: true }),
  ],
})
```

Follow [Configure Resend](/docs/server-primitives/email#configure-resend), [Configure SMTP](/docs/server-primitives/email#configure-smtp), or choose another `unemail/driver/*` provider behind the same `EmailDriver` contract.
Keep credentials in Server Env or the deployment platform's secret store; the Capability never exposes them to the model.

## Requirements

- The application must run on Node.js 24 or later.
- Email Definition discovery requires Vite 8 or later and exactly one supported Email Definition below the detected project root.
- The configured provider must authorize the `from` address.
- Generated Agent routes receive the Email runtime handle only while the Email Vite integration is active.

## Grant the Agent permission to send

Import `email()` from the official Capability catalog.
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

This configuration exposes one tool:

| Tool | Side effect | Result |
| --- | --- | --- |
| `email_send` | Sends one plain-text message from the configured sender. | The Email primitive's `{ id, driver }` acceptance result. |

A successful result means the active provider accepted the message and returned an ID.
It does not prove inbox delivery, display, or reading.

## Send a message

`email_send` accepts exactly three fields.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | `string \| readonly string[]` | Yes | One recipient address or a non-empty list. Every address must be non-empty. |
| `subject` | `string` | Yes | A non-empty subject. |
| `text` | `string` | Yes | A non-empty plain-text body. Do not include credentials or other secrets. |

The Capability fixes `from` from application configuration.
The model cannot set HTML, headers, attachments, carbon-copy recipients, blind-carbon-copy recipients, or reply routing through this tool.
The Capability checks that recipient strings are non-empty; the Email driver and provider still own mailbox syntax, sender authorization, and delivery rules.
ViteHub does not add recipient-count, text-length, payload-size, or send-rate limits beyond non-whitespace validation.
Your delivery provider owns those limits and may charge for every accepted recipient or message.

## Authorize recipients

Use `recipients` as the hard boundary for exact addresses the Agent may contact.
Every address in `email_send.to` must match the configured list; one address outside the list denies the entire call before the Email primitive runs, so ViteHub never partially sends a multi-recipient message.

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
The list becomes part of the Agent's model context; include only addresses that the model is allowed to see.

Matching trims surrounding whitespace and ignores letter case, but the Capability forwards the original address values to the Email provider.
Aliases, display-name forms, and other address variations remain different strings unless they appear explicitly in `recipients`.
Set `recipients: []` to deny all sends, or omit `recipients` when static recipient restriction belongs elsewhere.

The optional `policy` is an additional gate after this allowlist.
It cannot widen `recipients`: a configured `policy: 'allow'` still denies an address outside the list, while `policy: 'require-approval'` prompts only for an address that passed the list.
Without `policy`, allowed recipients send immediately; a policy callback can apply contextual authorization by returning `allow`, `deny`, `require-approval`, or `retryable-failure`.

Read [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) before enabling unattended delivery.

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
| `EMAIL_NOT_CONFIGURED` | Enable the Email integration and confirm exactly one Email Definition is discoverable. |
| `EMAIL_AUTHENTICATION` | Fix provider credentials or sender authorization before retrying. |
| `EMAIL_RATE_LIMITED` | Apply an application-owned backoff or queue policy. |
| `EMAIL_NETWORK` or `EMAIL_TIMEOUT` | Treat delivery as uncertain. Check provider delivery logs before retrying, because the provider may already have accepted the message. |
| `EMAIL_PROVIDER_FAILED` | Inspect protected server logs and provider delivery records. Never expose `cause` to the model. |

ViteHub-produced `ViteHubError.message` values are safe for the public runtime boundary.
ViteHub-wrapped provider failures remain in `cause` for protected server-side diagnostics and may contain addresses, credentials, or response content; custom drivers must preserve the same rule.

## Keep Dynamic Markdown application-owned

`email_send` is plain-text-only by design.
It does not render model-authored Markdown into HTML because [`renderEmailMarkdown()`](/docs/server-primitives/email#compose-dynamic-markdown) accepts trusted templates and does not sanitize authored HTML or trusted fragments.

When a product needs branded HTML, compose a trusted template in application code and call the Email primitive directly, or expose a [Custom Capability](/docs/capabilities/custom-capabilities) with a narrow set of escaped template values.
Do not pass unrestricted model output into a trusted HTML fragment.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `email_send` after the Email primitive resolves. |
| Harness-backed | Runtime requirements apply; model-facing Email tools are not passed by default. |
| Custom-run-backed | Receives the resolved tool set; `driver.run` decides whether and when to call `email_send`. |

## Inspect and verify

Run `vitehub agent info --agent <name> --json` and confirm its tool list contains only `email_send` for this Capability.
The Capability should report write mode and an `email` primitive requirement.

For the first delivery, use an approved test recipient and a test or sandbox provider account.
Approve the call, confirm the tool returns a non-empty `id`, then verify the same message in provider delivery logs or the recipient mailbox.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `from` | `string` | Required | Non-empty application-owned sender passed to every message. The provider still validates and authorizes it. |
| `recipients` | `readonly string[]` | `undefined` (no static allowlist) | Exact recipient allowlist. Every `to` address must match; an empty list denies all sends. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Optional approval or authorization policy for `email_send`. |

`email()` has no `mode` option because Email exposes no read operation.
The Capability always reports `mode: 'write'` so inspection and policy tooling can identify the side effect.

## Reference

- [Email primitive](/docs/server-primitives/email)
- [Official capabilities](/docs/capabilities/official-capabilities)
- [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces)
- Source: `packages/agent/src/capabilities/email.ts`
