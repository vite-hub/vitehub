---
title: Email limits and errors
description: Handle Email delivery errors and troubleshoot common failures.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle delivery errors

Use the `EMAIL_*` code for control flow and `details.driver` to identify the failing adapter. ViteHub keeps the original provider error in `cause` while exposing a safe public message.

```ts [server/send.ts]
import { getViteHubErrorShape } from 'vite-hub/runtime'
import { type EmailMessage } from 'vite-hub/email'
import { email } from 'vite-hub/email/server'

export async function send(message: EmailMessage) {
  try {
    return await email.send(message)
  }
  catch (error) {
    const shape = getViteHubErrorShape(error)
    if (shape?.code.startsWith('EMAIL_')) {
      console.error('Email delivery failed', {
        code: shape.code,
        driver: shape.details?.driver,
      })
    }
    throw error
  }
}
```

Inspect `cause` only in protected server-side diagnostics because provider errors can contain addresses, credentials, response text, or infrastructure details.

| Code | Produced by | Meaning | Retry guidance |
| --- | --- | --- | --- |
| `EMAIL_NOT_CONFIGURED` | Runtime configuration or driver `INVALID_OPTIONS` | The provider or required driver options are missing. | Fix configuration; do not retry unchanged. |
| `EMAIL_AUTHENTICATION` | Driver `AUTH` | Delivery credentials were rejected. | Fix credentials before retrying. |
| `EMAIL_RATE_LIMITED` | Driver `RATE_LIMIT` | The provider reported throttling. | Apply an application-owned retry policy. |
| `EMAIL_TIMEOUT` | Driver `TIMEOUT` | Delivery did not complete before the transport timeout. | Treat the outcome as uncertain before retrying. |
| `EMAIL_NETWORK` | Driver `NETWORK` | The driver could not reach its provider. | Treat the outcome as uncertain before retrying. |
| `EMAIL_PROVIDER_FAILED` | Driver `PROVIDER`, `UNSUPPORTED`, or `CANCELLED`; invalid success results | Delivery failed outside a more specific category. | Inspect protected diagnostics and provider delivery logs. |

Provider-specific classification and retry metadata come from the active driver. ViteHub maps its stable generic codes and validates that a successful result includes a non-empty message ID.

The package does not retry automatically. A timeout or disconnected response can occur after a provider accepted the message, so a blind retry can send a duplicate. Put retry and idempotency policy in Queue, Workflow, or the provider adapter that has enough information to make that decision.

## Troubleshoot common failures

### `No Email provider is configured`

Configure `vitehub({ email: { driver, options } })`. Applications using the owner integration directly configure `hubEmail({ driver, options })`. Restart the development server, then call `email.send()` again.

### `Email delivery failed through <driver>.`

Read the `EMAIL_*` code first. For `EMAIL_AUTHENTICATION`, verify the provider credentials and sender authorization. For `EMAIL_NETWORK` or `EMAIL_TIMEOUT`, verify DNS and outbound connectivity from the deployed server. Inspect `cause` and provider logs only on the server.

### The development outbox is empty

The outbox exists only in `vite dev` and keeps messages in memory, so a restart clears it. Send a message after the Development Server starts, then run `vitehub email outbox list`. `EMAIL_OUTBOX_DISABLED` means that the app sets `outbox: false`.
