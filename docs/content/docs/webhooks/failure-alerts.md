---
title: Alert on failed runs
description: Send a webhook when an Agent Invocation, a Workflow run, or a Schedule run fails, such as a message in a Slack channel.
navigation.title: Failure alerts
navigation.order: 9
icon: i-lucide-siren
---

List `events` in a webhook, and ViteHub sends it each failed run by itself. You do not call `sendWebhook()`.

```ts [server/webhooks/alerts.ts]
import { defineWebhook } from 'vite-hub/webhooks'

export default defineWebhook({
  url: 'ALERTS_WEBHOOK_URL',
  secret: 'ALERTS_WEBHOOK_SECRET',
  events: ['invocation.failed', 'workflow.failed', 'schedule.failed'],
  debounce: '10 minutes',
})
```

| Event | ViteHub sends it when |
| --- | --- |
| `invocation.failed` | An Agent Invocation fails and no retry is left. A queued Channel delivery that will run again does not send it. |
| `workflow.failed` | A Workflow run fails after its step retries. A failed step that OpenWorkflow or Cloudflare will try again does not send it. |
| `schedule.failed` | The handler of a Schedule run throws. |

The `debounce` is optional. With it, failures of the same Agent, Workflow, or Schedule in the window collapse into one delivery with the last failure, and `x-vitehub-events` counts them. A Workflow that fails 50 times in 10 minutes gives one alert, not 50. Other Workflows still get their own alert.

## The body

The receiver gets the event in `x-vitehub-event` and this JSON body, signed like every delivery:

```json
{
  "event": "workflow.failed",
  "workflow": "send-digest",
  "runId": "digest-2026-11-18",
  "error": { "message": "SMTP timeout", "code": "EMAIL_SEND_FAILED" },
  "failedAt": "2026-11-18T07:00:04.120Z",
  "text": "The Workflow run digest-2026-11-18 of \"send-digest\" failed: SMTP timeout"
}
```

| Event | Fields |
| --- | --- |
| `invocation.failed` | `agent` (the Agent name, or `null`), `invocationId` |
| `workflow.failed` | `workflow`, `runId` |
| `schedule.failed` | `schedule`, `runId` |

Every event also has `error.message`, `error.code` when the error has a code, `failedAt`, and `text`: one line for a person to read. An Agent with `redactError` sends the redacted error. The type of the body is `WebhookEventBody` from `vite-hub/webhooks`.

## Slack and Discord

A Slack [incoming webhook](https://api.slack.com/messaging/webhooks) shows the `text` field as the message. Set `ALERTS_WEBHOOK_URL` to the Slack URL. Slack does not check the signature, but `secret` is still required, so set `ALERTS_WEBHOOK_SECRET` to any random value.

For Discord, add `/slack` to the end of the Discord webhook URL. Discord then reads the same `text` field.

## Where it runs

The process that runs the failed code must load the app's Webhooks. A Cloudflare cron that runs in the app's Nitro Worker can send `schedule.failed`. Standalone cron entries, including Vercel and Netlify cron functions, do not load the app's Webhooks and do not send alerts. A Vercel Workflow that runs in the Workflow DevKit (a `native` entry) does not send `workflow.failed` because it runs in a separate sandbox.
