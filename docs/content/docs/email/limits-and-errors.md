---
title: Email limits and errors
description: Handle Email delivery errors and troubleshoot common failures.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle delivery errors

`email.send()` returns `[error, sent]`. When `error` is set, `error.code` names the failure, `error.why` tells what went wrong and names the driver, `error.fix` tells what to do, and `error.docs` links to the code on this page. `error.cause` keeps the provider error.

```ts [server/send.ts]
import { type EmailMessage } from 'vite-hub/email'
import { email } from 'vite-hub/email/server'

export async function send(message: EmailMessage) {
  const [error, sent] = await email.send(message)
  if (error) {
    console.error('Email delivery failed', { code: error.code, why: error.why })
    throw error
  }
  return sent
}
```

The type of `error.code` is `EmailErrorCode`, the union of the codes in the first table.

Log `cause` only on the server, because provider errors can contain addresses, credentials, response text, or infrastructure details. `JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`, so you can return the error from a route or an Agent tool.

| Code | Driver code | Retry guidance |
| --- | --- | --- |
| `EMAIL_INVALID_MESSAGE` | `INVALID_OPTIONS` | Correct the message. Do not retry it unchanged. |
| `EMAIL_AUTHENTICATION` | `AUTH` | Fix the credentials before you retry. |
| `EMAIL_RATE_LIMITED` | `RATE_LIMIT` | Retry later with backoff. |
| `EMAIL_TIMEOUT` | `TIMEOUT` | The outcome is not certain. Check the provider logs before you retry. |
| `EMAIL_NETWORK` | `NETWORK` | The outcome is not certain. Check the provider logs before you retry. |
| `EMAIL_PROVIDER_FAILED` | `PROVIDER`, `UNSUPPORTED`, `CANCELLED`, an invalid message id, or any other failure | Read `cause` and the provider logs. |

Configuration errors throw instead, because the configuration must change before a send can work:

| Code | When |
| --- | --- |
| `EMAIL_NOT_CONFIGURED` | No provider is configured, or the driver reports `NOT_CONFIGURED`, for example a missing API key. |
| `EMAIL_INVALID_DRIVER` | `createEmail()` receives a value that is not a driver. |

The package does not retry automatically. A timeout or a lost response can occur after the provider accepted the message, so a blind retry can send a duplicate. Put retry and idempotency policy in Queue, Workflow, or the driver that has enough information to make that decision.

## Runtime errors

### EMAIL_INVALID_MESSAGE

The driver rejected the message, for example an empty address, a missing `from`, or an unsubscribe URL that is not HTTPS. `cause` names the field.

### EMAIL_AUTHENTICATION

The provider rejected the credentials, or it does not authorize the sender. Check the API key or binding, and the sender domain.

### EMAIL_RATE_LIMITED

The provider rate limited the request. Retry later with backoff, for example from a Queue.

### EMAIL_TIMEOUT

Delivery did not complete before the transport timeout. The provider can have accepted the message. Check its delivery logs, or retry with the same `idempotencyKey`.

### EMAIL_NETWORK

The driver could not reach its provider. Check DNS and outbound network access from the server.

### EMAIL_PROVIDER_FAILED

Delivery failed outside a more specific category. Read `cause` in server logs and the delivery logs of the provider.

## Configuration errors

### EMAIL_NOT_CONFIGURED

Configure `vitehub({ email: { driver, options } })`. Applications that use the owner integration directly configure `hubEmail({ driver, options })`. When a driver reports invalid options, `cause` names the option. Restart the development server, then call `email.send()` again.

### EMAIL_INVALID_DRIVER

Pass a driver from `@vite-hub/email/drivers/*`, or an object with a `name` and a `send()` function.

## Build errors

The Vite plugin throws these errors while it reads the config or the templates.

### EMAIL_UNKNOWN_DRIVER

Set `driver` to `"resend"` or `"cloudflare-email"`.

### EMAIL_HOST_UNSUPPORTED

The `cloudflare-email` driver needs a Cloudflare host. Deploy to Cloudflare, or use `resend`.

### EMAIL_SECRET_DEFAULT

A secret Email option has a default. Defaults are included in build output, so remove the default and set the secret in the host environment.

### EMAIL_SYNC_OPTION_REQUIRED

An Email option uses `env.provider()`. Email resolves its options synchronously, so read the value with `env.source()`.

### EMAIL_INVALID_OUTBOX

Set `email.outbox` to `false`, or to `{ deliver, limit }` with a boolean `deliver` and an integer `limit` from 1 to 1000.

### EMAIL_INVALID_TEMPLATE

Import `#vitehub/emails/<name>`, where `<name>` is the path under `server/emails` without `.md`.

### EMAIL_DUPLICATE_TEMPLATE

Two Markdown files under the `server/emails` roots have the same name. Rename or remove one of them.

### EMAIL_CLI_USAGE

`vitehub email` received an option or a value that it cannot use. Run `vitehub email --help`.

## Troubleshoot common failures

### The development outbox is empty

The outbox exists only in `vite dev` and keeps messages in memory, so a restart clears it. Send a message after the Development Server starts, then run `vitehub email outbox list`. `EMAIL_OUTBOX_DISABLED` means that the app sets `outbox: false`.
