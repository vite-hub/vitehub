---
title: Invocations
description: Run, stream, and inspect one Agent Invocation.
navigation.order: 23
icon: i-lucide-play-circle
---

An Agent Invocation is one runtime request to an Agent. It receives input, resolves the Agent Actor, applies Capabilities, runs the selected Agent Driver, records lifecycle state, and returns or streams output.

Invoke Agents from server code, Agent Triggers, schedules, the CLI Dev Loop, or framework-owned routes. The invocation input carries prompt or message content plus trusted context values.

Read [Agent Invocations](/docs/concepts/agent-invocations) for the request boundary and its relationship to Agent Definitions, Channels, Chat Sessions, and Workflow Runs.

## Run an Agent

Use `runAgent` when the caller expects a final result. Pass [Runtime Context](/docs/concepts/runtime-context) separately from invocation input so host resources and task data keep distinct boundaries.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)
  const user = await requireAuthenticatedUser(event)

  return runAgent(support, {
    memo: (_key, create) => create(),
    runtime: 'unknown',
    waitUntil: task => { void task.catch(() => {}) },
  }, {
    prompt: body.prompt,
    context: {
      invoker: {
        id: user.id,
        kind: 'customer',
        label: user.email,
        meta: { customer: user.customer },
      },
    },
  })
})
```

The `context.invoker` input is the current API field for a trusted Agent Actor. Validate the request before passing identity or access facts into ViteHub; callbacks receive the normalized Actor as both `actor` and `invoker`.

## Stream an Agent

Use `streamAgent` when a UI or channel should receive incremental output. The same Agent Driver and Capability boundaries apply.

```ts [server/api/support-stream.post.ts]
import { streamAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event)

  return streamAgent(support, {
    memo: (_key, create) => create(),
    runtime: 'unknown',
    waitUntil: task => { void task.catch(() => {}) },
  }, {
    prompt: body.prompt,
  }, {
    output: 'ui-message-stream',
  })
})
```

Use `output: 'events'` when an internal caller wants ViteHub stream events. Use `output: 'ui-message-stream'` when a chat UI expects UI message stream chunks.

## Inspect invocation data

Every Agent Invocation receives a trace context and a metadata-only in-memory Trace Event Log. Agent runtime callbacks can inspect `runtime.trace` and `runtime.traceLog`. A host can supply its own trace context or Trace Event Log when it needs request-trace continuity, a shared log, a different content policy, or an `onEntry` sink. ViteHub preserves the supplied objects; it does not persist the default log.

That preservation applies to inline Agent Invocations. A workflow-backed invocation crosses a durable serialization boundary, so process-local Trace Event Logs and `onEntry` sinks are not carried into the Workflow Run. The workflow execution creates its own invocation trace instead.

Agent Finish Hooks receive core completion facts by default:

```ts [server/agents/support.ts]
export default defineAgent({
  driver: { model },
  hooks: {
    'agent:finish'(event) {
      const { durationMs, resultKind, usage } = event.invocation
      event.runtime.waitUntil(recordInvocation({ durationMs, resultKind, usage }))
    },
  },
})
```

The finish hook runs before the invocation's terminal Trace Event. Agent tests and eval observations expose the finalized `TraceRunView` as `result.trace` or `observation.trace` after completion. Stream and Response traces become terminal when the caller consumes, cancels, or encounters an error from the output.

## Publish application run events

Use Agent Run Events when server code needs to expose application-owned progress across Capability input, Agent Driver, and finish phases. Define the store beside the Agent so Workflow execution imports the resolver instead of serializing it in the Workflow payload.

```ts [server/agents/summary/agent.ts]
import { defineAgent } from '@vite-hub/agent'
import { defineAgentRunEvents } from '@vite-hub/agent/server'
import { summaryRunEventStore } from '../../run-event-store'

export const summaryRunEvents = defineAgentRunEvents({
  store: context => summaryRunEventStore(context),
})

export default defineAgent({
  runEvents: summaryRunEvents,
  capabilities: [{
    id: 'transcribe',
    async input(context) {
      await context.runEvents?.publish({
        type: 'stage',
        data: { stage: 'transcribe' },
      })
    },
  }],
  driver: {
    async run(context) {
      await context.runEvents?.publish({
        type: 'stage',
        data: { stage: 'summarize' },
      })
      return summarize(context)
    },
  },
})
```

The publisher exists only when the invocation has a stable `runId`; ViteHub does not invent a second identity for inline calls. Workflow-backed Agents use the Workflow Run id, while Capability input, the Agent Driver, and finish hooks remain phases inside that one run rather than separate Workflow steps.

Server routes can call `summaryRunEvents.read(runId, cursor)` for replay or `summaryRunEvents.subscribe(runId, cursor, { signal })` for replay followed by live events. The configured store owns cursor assignment, ordering, timestamps, persistence, and the replay-to-live handoff, and it must stop subscriptions when the abort signal fires. ViteHub supplies no default persistence or authorization; authenticate the server route and scope every store operation to the application's run owner.

## Invoke a trigger

Use `runAgentTrigger` or `streamAgentTrigger` when a Capability owns the product event shape. The trigger prepares Agent Invocation input, metadata, and run state before the Agent Driver starts.

```ts [server/api/support-chat.post.ts]
import { streamAgentTrigger } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text: string }>(event)
  const runId = crypto.randomUUID()

  return streamAgentTrigger(support, {
    memo: (_key, create) => create(),
    runtime: 'unknown',
    waitUntil: task => { void task.catch(() => {}) },
  }, 'chat.message', {
    messages: [{
      id: runId,
      parts: [{ text: body.text, type: 'text' }],
      role: 'user',
    }],
    run: {
      channelId: 'support-web',
      messageId: runId,
      origin: 'portal',
      runId,
    },
  }, {
    output: 'ui-message-stream',
  })
})
```

Agent Trigger Consumers call the trigger surface. They do not own the Capability behavior that registered the trigger. The `run` field remains Agent Run metadata for the invocation rather than Chat context.

## Input lifecycle

Use an Agent Input Hook when an Agent needs to validate trusted invocation context before its Agent Driver runs. Input hooks run once per Agent Invocation after Capabilities prepare input.

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run: () => 'ok',
  },
  hooks: {
    'agent:input'(context) {
      if (!context.input.context?.pullRequest) {
        throw new Error('Missing GitHub field: context.pullRequest')
      }
    },
  },
})
```

## Finish lifecycle

Use an Agent Finish Hook to observe the completed invocation. Finish hooks are appropriate for usage export, trace collection, cleanup, or product-side notifications. Read normalized usage directly from `event.invocation.usage`.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: 'Answer support requests.',
  },
  hooks: {
    'agent:finish'(event) {
      const usage = event.invocation.usage
      if (!usage) return
      event.runtime.waitUntil(recordUsage(usage))
    },
  },
})
```

Finish hooks can also return channel delivery effects. Use `event.reply()`, `event.reaction()`, or `event.status()` and return one effect or an array; ViteHub delivers them after Capability finish effects.

```ts [server/agents/support.ts]
export default defineAgent({
  driver: { run: () => 'Done' },
  hooks: {
    'agent:finish'(event) {
      return event.reply('Usage recorded.')
    },
  },
})
```

Finish hooks should not quietly grant new abilities. Capabilities and Agent Drivers remain the authority boundaries.

### Handle failures

When an Agent Invocation fails, the finish event keeps the original thrown value on `event.error` and exposes a normalized message on `event.errorMessage`.

Use `event.errorMessage` for status updates, logs, and delivery effects. Use `event.error` only when you need to inspect the original thrown value.

```ts [server/agents/support.ts]
export default defineAgent({
  driver: {
    run: () => {
      throw new Error('Support sync failed')
    },
  },
  hooks: {
    'agent:finish'(event) {
      if (event.errorMessage) {
        event.runtime.waitUntil(reportFailure(event.errorMessage))
      }
    },
  },
})
```

## Next steps

- Read [Triggers](/docs/agents/triggers) for Channel and Capability trigger paths.
- Read [Agent Actors](/docs/agents/actors) for trusted caller identity and exact `invoker` API names.
- Read [CLI inspection](/docs/development/cli) to inspect Agent Invocation state.
