---
title: Workflows limits and errors
description: Throw Workflow errors with stable codes, and check a Workflow and its provider before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Structured errors

Throw `ViteHubError` for failures that look the same on every provider. ViteHub's own failures use the fixed `WorkflowErrorCode` list.

```ts [server/workflows/transcribe.ts] fragment
import { ViteHubError } from 'vite-hub/runtime'
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow('transcribe', async (payload: { recordingId: string }) => {
  try {
    return await transcribeRecording(payload.recordingId)
  }
  catch (cause) {
    throw new ViteHubError('TRANSCRIPTION_FAILED', 'Transcription failed.', {
      cause,
      details: { recordingId: payload.recordingId },
    })
  }
})
```

Every `ViteHubError` needs a stable `code` and a public `message`. `error.toJSON()` returns `name`, `code`, `message`, and JSON-safe `details`. It leaves out `cause`, which stays on the error in memory for debugging. Built-in codes have the `WorkflowErrorCode` type, with a message and details per code. When a run fails, `getWorkflowRun()` returns the thrown error as `run.error`: its `message`, and its `name` when it is not `Error`. Inline runs also keep its `code`. Cloudflare and OpenWorkflow store only the name and the message. Native Vercel runs read the error after Workflow DevKit serialization, which drops custom `code` properties on ordinary Errors. Application error codes are therefore not portable across providers. The stack, `cause`, and `details` stay out. A thrown error does not change its retry policy. To stop the retries, throw a [`NonRetryableError`](#stop-the-retries).

When a provider call fails, `startWorkflow()`, `getWorkflowRun()`, `cancelWorkflow()`, and `resumeWorkflow()` return the error `WORKFLOW_PROVIDER_OPERATION_FAILED` as `[error, undefined]`. `error.cause` is the provider error. `error.data` tells you what happened:

| Field | Value |
| --- | --- |
| `provider`, `operation` | The provider and the call, for example `cloudflare` and `create`. |
| `status` | The HTTP status of the provider, when it sent one. |
| `reason` | The provider error name and the first line of its message, at most 200 characters. ViteHub removes URLs, file paths, and credentials. |
| `acknowledgement` | `rejected`: the provider refused the call, so nothing started. `unknown`: the call may have reached the provider. |

If the outcome of a start is unknown and you supplied a run `id`, check that ID with `getWorkflowRun()` and reuse the same ID if you retry. If you do not know the original ID, verify whether the run started before trying again. A new ID does not identify the original run.

In development, the server log also shows the full provider error.

## Retries and sleeps

When a step file throws, the provider runs it again. By default, a step gets 3 retries after the first attempt: 10 seconds later, then 20, then 40. Export `retries` and `timeout` from a step file to change this for that step:

```ts [server/workflows/sync-repo/01.fetch-issues.ts]
import type { WorkflowStepContext, WorkflowStepRetries } from 'vite-hub/workflow'

export const retries = { limit: 5, delay: '30 seconds', backoff: 'exponential' } satisfies WorkflowStepRetries
export const timeout = '2 minutes'

export default async function fetchIssues(input: { repo: string }, { signal }: WorkflowStepContext) {
  const response = await fetch(`https://api.github.com/repos/${input.repo}/issues`, { signal })
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const issues: { number: number, title: string }[] = await response.json()
  return issues
}
```

- `limit` is the number of retries after the first attempt. `0` runs the step once.
- `delay` is the wait before the first retry, in milliseconds or as a duration such as `'30 seconds'`. `backoff: 'exponential'` doubles the wait after each retry. `'constant'` keeps it the same.
- `timeout` is the time limit of one attempt. When it passes, `signal` aborts and the attempt fails with `WORKFLOW_STEP_TIMEOUT`. Then the step retries as `retries` says.
- Write the values as literals. The build reads them from the file. It fails with `WORKFLOW_STEP_OPTIONS_NOT_STATIC` when it cannot read a value, and with `WORKFLOW_STEP_OPTIONS_INVALID` for a value that is not valid.

| Provider | `retries` | `timeout` |
| --- | --- | --- |
| Cloudflare | Sent to `step.do()`. | Sent to `step.do()`. Without `timeout`, Cloudflare stops an attempt after 10 minutes. |
| OpenWorkflow | Sent as the step's `retryPolicy`, with `maximumAttempts: limit + 1`. | ViteHub aborts `signal` and fails the attempt. |
| Vercel, folder without `index.ts` | `limit` becomes Workflow DevKit's `maxRetries`. DevKit retries a step after about one second, so `delay` or `backoff` fails the build with `WORKFLOW_STEP_RETRY_DELAY_UNSUPPORTED`. | ViteHub aborts `signal` and fails the attempt. |
| Inline (`vite dev`, normal Vercel handlers) | No retries. | ViteHub aborts `signal` and fails the attempt. |

> [!NOTE]
> Only Cloudflare enforces `timeout` itself. Elsewhere, ViteHub cannot stop code that ignores `signal`: the attempt fails, and the next attempt can start while the old one still runs. Pass `signal` to `fetch()` and to every other call that takes one.

A Vercel `native` entry that you write follows the Workflow DevKit rules. [What ViteHub stores on each host](/docs/guides/durable-execution#what-vitehub-stores-on-each-host) compares the providers.

### Stop the retries

Throw `NonRetryableError` when another attempt cannot succeed, for example when the card is declined. The run fails at once, and the provider does not run the step again.

```ts [server/workflows/checkout/01.charge.ts] fragment
import { NonRetryableError } from 'vite-hub/workflow'

export default async function charge(payload: { cardId: string }) {
  const charge = await chargeCard(payload.cardId)
  if (charge.status === 'declined') {
    throw new NonRetryableError('The card was declined.', { cause: charge })
  }
  return charge
}
```

It works in a step file, in a single-file Workflow, and in a `native` entry:

| Provider | What stops the retries |
| --- | --- |
| Cloudflare | ViteHub throws the Cloudflare `NonRetryableError` from `cloudflare:workflows`. |
| Vercel `native` | Workflow DevKit reads `fatal: true`, as for its own `FatalError`. |
| OpenWorkflow | OpenWorkflow has no such error. ViteHub ends the step with the error as its result, then fails the run outside the step. A replay reads the result and throws the same error. |
| Inline | An inline run does not retry. |

`getWorkflowRun()` reports `status: 'failed'`. Where the error shows:

| Provider | Error in `getWorkflowRun()` |
| --- | --- |
| Inline, OpenWorkflow | `error` has the failure `message` and `name`. On OpenWorkflow, the step also reports `failed` with the message. |
| Cloudflare | `error` has the failure `message` and `name`. `metadata` also keeps the Cloudflare status record. |
| Vercel `native` | `error` has the failure `message` and `name`. `metadata` is `{ workflow }`. The failed step in `steps` also has the message. |

ViteHub finds the error by `isRetryable === false` or by the name `NonRetryableError`, so an error from another copy of the package also works. In a folder `index.ts` on OpenWorkflow, a `catch` gets a new `NonRetryableError` with the same `name`, `message`, and `code`, not the original object.

A `setTimeout` in a handler is not durable. Only a folder Workflow can sleep. Its `index.ts` calls `context.sleep()` between steps, with a duration or a `Date`:

```ts [server/workflows/remind-user/index.ts] fragment
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow('remind-user', async (payload: { email: string, remindAt: string }, { sleep, steps }) => {
  await steps.sendWelcome(payload)
  await sleep('1 day')
  await sleep(new Date(payload.remindAt))
  await steps.sendReminder(payload)
})
```

A duration is a number of milliseconds or a string such as `'30 seconds'` or `'1 day'`: a number, one space, and a unit (second, minute, hour, day, week, month, or year, with or without a final `s`). A month is 30 days and a year is 365.25 days. Another form throws `WORKFLOW_SLEEP_DURATION_INVALID`.

| Provider | Sleep |
| --- | --- |
| Cloudflare | Durable. Uses `step.sleep()` and `step.sleepUntil()`, at most 365 days. |
| OpenWorkflow | Durable. Stores the wake time in its database. |
| Inline runs (`vite dev`, normal Vercel handlers) | Waits with a timer. Not durable: a restart loses the run. |
| Vercel `native` entry | Use `sleep()` from Workflow DevKit. |

After a sleep, the provider runs `index.ts` again from the start. Completed step files return their stored results and do not run again, so put each side effect in a numbered step file. ViteHub names each sleep by call order (`sleep-1`, `sleep-2`), so `index.ts` must call `sleep()` in the same order on each replay. Put a value that changes, such as `Date.now()`, in a step file.

`getWorkflowRun()` lists each OpenWorkflow sleep in `steps`, with the name `sleep-1` and the wake time in `sleepUntil`. A sleeping Cloudflare run reports `running`, and `metadata.status` is `waiting`.

A single-file Workflow, such as `server/workflows/remind-user.ts`, runs as one root step. A replay after a sleep would run the code before the sleep again. So `context.sleep()` in a root step throws `WORKFLOW_ROOT_STEP_SLEEP` on every provider, and the run fails without a retry. Move the Workflow to a folder to fix it.

## Production checks

Use Queue when background delivery is enough. Use Workflow when you must inspect run state, resume work, or run several steps over time.

Keep credentials and database URLs in Server Env. Hosted providers may need their own state storage or deploy setup.
