---
title: Email limits and errors
description: Handle Email delivery errors by code, fix runtime, configuration, and build errors, and troubleshoot common failures.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle delivery errors

`email.send()` returns `[error, sent]`. When `error` is set, `error.code` names the failure, `error.why` says what went wrong and names the driver, `error.fix` says what to do, and `error.docs` links to the code in [Email diagnostics](/docs/email/diagnostics). `error.cause` keeps the provider error.

```ts [server/send.ts]
import { type EmailMessage, email } from 'vite-hub/email'

export async function send(message: EmailMessage) {
  const [error, sent] = await email.send(message)
  if (error) {
    console.error('Email delivery failed', { code: error.code, why: error.why })
    throw error
  }
  return sent
}
```

`error.code` has the type `EmailErrorCode`, the codes in the first table.

> [!WARNING]
> Log `cause` only on the server. Provider errors can contain addresses, credentials, response text, or infrastructure details.

`JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`, so you can return the error from a route or an Agent tool.

| Code | Driver code | Retry guidance |
| --- | --- | --- |
| `EMAIL_INVALID_MESSAGE` | `INVALID_OPTIONS` | Correct the message. Do not retry it unchanged. |
| `EMAIL_AUTHENTICATION` | `AUTH` | Fix the credentials before you retry. |
| `EMAIL_RATE_LIMITED` | `RATE_LIMIT` | Retry later with backoff. |
| `EMAIL_TIMEOUT` | `TIMEOUT` | The outcome is not certain. Check the provider logs before you retry. |
| `EMAIL_NETWORK` | `NETWORK` | The outcome is not certain. Check the provider logs before you retry. |
| `EMAIL_PROVIDER_FAILED` | `PROVIDER`, `UNSUPPORTED`, `CANCELLED`, an invalid message id, or any other failure | Read `cause` and the provider logs. |

Configuration errors throw instead, because the config must change before a send can work:

| Code | When |
| --- | --- |
| `EMAIL_NOT_CONFIGURED` | No provider is configured, or the driver reports `NOT_CONFIGURED`, for example a missing API key. |
| `EMAIL_INVALID_DRIVER` | `createEmail()` receives a value that is not a driver. |

Email does not retry. A timeout or lost response can happen after the provider accepted the message, so a blind retry can send a duplicate. Put retry and idempotency rules in Queue, Workflow, or a driver that knows enough to decide.

## Runtime errors

### EMAIL_INVALID_MESSAGE

ViteHub or the driver rejected the message, for example for an empty address, a missing `from`, a non-HTTPS unsubscribe URL, or a message without `text` and `html`. `cause` names the field.

ViteHub also rejects fields that no driver sends, such as `template`, `react`, `mjml`, `preheader`, or `personalizations`. Render the body yourself and pass it as `html` or `text`.

### EMAIL_AUTHENTICATION

The provider rejected the credentials or the sender. Check the API key or binding, and the sender domain.

### EMAIL_RATE_LIMITED

The provider rate limited the request. Retry later with backoff, for example from a Queue.

### EMAIL_TIMEOUT

Delivery did not finish before the transport timeout. The provider may have accepted the message. Check its delivery logs, or retry with the same `idempotencyKey`.

### EMAIL_NETWORK

The driver could not reach its provider. Check DNS and outbound network access from the server.

### EMAIL_PROVIDER_FAILED

Delivery failed for a reason no other code covers. Read `cause` in server logs and the provider's delivery logs.

## Configuration errors

### EMAIL_NOT_CONFIGURED

Set `vitehub({ email: { driver, options } })`, or `hubEmail({ driver, options })` if you use the Email plugin directly. When a driver reports invalid options, `cause` names the option. Restart the dev server, then call `email.send()` again.

### EMAIL_INVALID_DRIVER

Pass a driver from `@vite-hub/email/drivers/*`, or an object with a `name` and a `send()` function.

## Build errors

The Vite plugin throws these while it reads the config or templates.

### EMAIL_UNKNOWN_DRIVER

Set `driver` to `"resend"` or `"cloudflare-email"`.

### EMAIL_HOST_UNSUPPORTED

The `cloudflare-email` driver needs a Cloudflare host. Deploy to Cloudflare, or use `resend`.

### EMAIL_SECRET_DEFAULT

A secret Email option has a default. Defaults go into build output, so remove the default and set the secret in the host environment.

### EMAIL_SYNC_OPTION_REQUIRED

An Email option uses `env.provider()`. Email reads its options synchronously, so use `env.source()`.

### EMAIL_INVALID_OUTBOX

Set `email.outbox` to `false`, or to `{ limit }` with an integer `limit` from 1 to 1000. `outbox.deliver` was removed. A dev send stays in the outbox unless `email.remote` is `true`.

### EMAIL_INVALID_REMOTE

`email.remote` must be a boolean. Set `remote: true` to send `vite dev` email through the provider, or remove it to keep dev sends in the outbox.

### EMAIL_REMOTE_REQUIRED

`vite dev` has `email.outbox: false` without `email.remote: true`, so a dev send has nowhere to go. Remove `outbox: false`, or set `remote: true` to send dev email through the provider. Builds do not check this.

### EMAIL_INVALID_TEMPLATE

Import `#vitehub/emails/<name>`, where `<name>` is the path under `server/emails` without `.md`.

### EMAIL_DUPLICATE_TEMPLATE

Two Markdown files under the `server/emails` roots have the same name. Rename or remove one.

### EMAIL_CLI_USAGE

`vitehub email` got an option or value it cannot use. Run `vitehub email --help`.

## Troubleshoot common failures

### The development outbox is empty

The outbox exists only in `vite dev` and keeps messages in memory, so a restart clears it. Send a message after the dev server starts, then run `vitehub email outbox list`. `EMAIL_OUTBOX_DISABLED` means the app sets `outbox: false`.
