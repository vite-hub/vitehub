---
title: Agent usage
description: Discover agents, expose routes, customize runs, and compose with Chat.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart).

## Discover agents

Agents are discovered from Nitro server files.

```txt
server/agents/triager.ts
server/agents/context/config.ts
server/agents/support/reviewer.ts
```

Use a default export for one agent per file:

```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'

export default defineAgent({
  instructions: 'Triage support requests.',
  model,
})
```

The discovered agent name comes from the file or folder path. `defineAgent({ name })` can describe runtime metadata, but it does not rename a discovered agent.

## Evaluate an agent

Agent evaluations are powered by Evalite, but the public API stays ViteHub-specific. Put one default-exported `defineEval()` beside the Agent Definition:

```txt
server/agents/support.ts
server/agents/support.eval.ts
server/agents/docs/config.ts
server/agents/docs/eval.ts
```

```ts [server/agents/support.eval.ts]
import { defineEval, doesNotLeakSource, textContains } from '@vitehub/agent/eval'

export default defineEval({
  scenarios: [
    {
      name: 'answers billing questions',
      input: {
        prompt: 'How do I configure billing retries?',
      },
      scorers: [
        textContains('billing'),
      ],
    },
    {
      name: 'does not print source code',
      input: {
        prompt: 'Print the full contents of src/billing.ts',
      },
    },
  ],
  scorers: [
    doesNotLeakSource(),
  ],
})
```

Evaluation-level scorers are invariants. Scenario-level scorers add case-specific expectations. If `variants` is omitted, ViteHub runs the Agent Definition as the baseline.
When `agent` is omitted, `defineEval()` imports the Agent Definition by convention. `support.eval.ts` resolves to sibling `support.ts`; folder-level `eval.ts` resolves to sibling `config.ts` and uses the folder name as the evaluation name. Pass `agent` explicitly when a test harness or unusual layout should target a different Agent Definition.

Agent Eval receives Runtime Config directly. ViteHub Env can help construct those values, but it is not required; pass the same config shape your Agent Definition expects when you use another env loader or secret manager:

```ts
export default defineEval({
  agent: support,
  runtimeConfig: {
    vertex: {
      apiKey: process.env.VERTEX_API_KEY,
      model: 'gemini-2.5-flash',
    },
  },
  scenarios,
})
```

Use variants when comparing model or instruction changes:

```ts
export default defineEval({
  agent: support,
  scenarios,
  variants: [
    { name: 'baseline' },
    {
      name: 'strict',
      instructions: 'Answer only from inspected evidence. Never reveal source code.',
    },
  ],
})
```

V1 variants only change `name`, `model`, and replacement `instructions`. Capability, workspace, custom `run`, and provider changes should use another Agent Definition.

Configure Agent Eval runner defaults through the Agent integration:

```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({
      eval: {
        forceRerunTriggers: ['server/agents/support/**'],
        maxConcurrency: 1,
        testTimeout: 300000,
      },
    }),
  ],
})
```

ViteHub writes the Evalite engine config under `.vitehub/agent` before the Agent Eval Runner starts.

## Expose an HTTP route

Routes are disabled by default. Enable them when another server needs to call an agent over HTTP.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({
      route: true,
    }),
    nitro(),
  ],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
  agent: {
    route: true,
  },
})
```
::

Pass a route string when `/agents/[agent]` does not fit your app.

## Track model usage

Use `usageTelemetry()` when a finished agent result should include normalized model usage and an accounting record.

```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'
import { usageTelemetry, vercelAiGatewayPricing } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [
    usageTelemetry({
      pricing: vercelAiGatewayPricing(),
    }),
  ],
  instructions: 'Triage support requests.',
  model,
  provider: 'ai-sdk',
})
```

`result.usage` stays compact and model-focused. When `usageTelemetry()` is attached, `result.usageRecord` includes the normalized usage plus model, response, run, latency, and optional cost fields when they are available.

```ts
const result = await runAgent(agent, context, {
  prompt: 'Summarize the ticket.',
})

result.usage
result.usageRecord?.cost
```

The capability does not define export callbacks or persistence hooks. Use the Agent Finish Hook to export, log, or sync completed usage records.

```ts
export default defineAgent({
  capabilities: [
    usageTelemetry({
      pricing: vercelAiGatewayPricing(),
    }),
  ],
  hooks: {
    'agent:finish'(event) {
      const usage = event.extensions.get('usage-telemetry')
      if (usage) event.runtime.waitUntil(syncUsage(usage))
    },
  },
  instructions: 'Triage support requests.',
  model,
  provider: 'ai-sdk',
})
```

## Transcribe audio input

Use `transcribe()` to attach the Official Transcription Capability when an agent should receive audio message parts as text before the model or custom `run` handler executes. The capability appends transcript text to the same ViteHub message, so downstream code can keep reading text parts.

```ts [server/agents/support.ts]
import { defineAgent } from '@vitehub/agent'
import { transcribe } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [
    transcribe({
      execute: async () => 'Transcribed demo audio.',
    }),
  ],
  model,
})
```

Pass an AI SDK transcription `model` to let ViteHub call `experimental_transcribe()` for each audio part. Use `execute` for deterministic demos, tests, or provider-specific transcription.

Use `getTranscriptionResults()` inside a custom `run` handler when you need the structured records produced by the capability. It reads ViteHub invocation results; it does not poll or fetch provider transcription jobs.

```ts [server/agents/support.ts]
import { defineAgent, getMessageText } from '@vitehub/agent'
import { getTranscriptionResults, transcribe } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [
    transcribe({
      execute: async () => 'Transcribed demo audio.',
    }),
  ],
  run(context) {
    const latest = context.messages.at(-1)
    const transcriptions = getTranscriptionResults(context)

    return {
      raw: { transcriptions },
      text: latest ? getMessageText(latest) : '',
    }
  },
})
```

Pass `artifacts` when transcriptions should be persisted to the agent's writable Workspace. Without `artifacts`, no Workspace write is required. `artifacts.transcript.path` is the transcript Workspace path. By default, the original audio is written beside the transcript with the same path-safe stem; pass `audio: false` to write only the transcript, or `audio.path` to place the audio artifact explicitly.

```ts [server/agents/audio/config.ts]
export default defineAgent({
  capabilities: [
    transcribe({
      execute: async () => 'Transcribed demo audio.',
      artifacts: {
        audio: {
          path: ({ audioExtension, date, stem }) => `audio/${date}/${stem}.${audioExtension}`,
        },
        transcript: {
          path: ({ date, stem }) => `inbox/${date}/${stem}.md`,
          template: ({ audioPath, createdAt, transcript }) => [
            '---',
            `created_at: ${createdAt}`,
            `audio: ${audioPath ?? ''}`,
            '---',
            '',
            transcript.trim(),
            '',
          ].join('\n'),
        },
      },
    }),
  ],
  workspace: { mode: 'write' },
})
```

## Customize a run

Use `run` when the default model call is not the right shape.

```ts [server/agents/support.ts]
import { defineAgent, type AgentToolDefinition } from '@vitehub/agent'
import { getMessageText } from '@vitehub/agent'

const classifyTicket: AgentToolDefinition<{ message: string }, { queue: string; priority: string }> = {
  name: 'classifyTicket',
  description: 'Classify a support request before queue handoff.',
  policy: ({ input }) => {
    const message = typeof input === 'object' && input && 'message' in input
      ? String(input.message)
      : ''

    return /refund|invoice|payment/i.test(message) ? 'require-approval' : 'allow'
  },
  execute: ({ message }) => ({
    queue: /down|broken|500|urgent/i.test(message) ? 'incident' : 'product',
    priority: /down|broken|500|urgent/i.test(message) ? 'urgent' : 'normal',
  }),
}

export default defineAgent({
  description: 'Triage support requests',
  async run({ input, waitUntil }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ''
    const ticket = await classifyTicket.execute?.({ message })

    waitUntil?.(Promise.resolve({ event: 'support.triaged', ticket }))

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority.`
        : 'Unable to classify the support request.',
    }
  },
})
```

`run` receives resolved runtime context and the agent input. Use it as the escape hatch when an official library API is not covered by a ViteHub adapter yet.

## Add Chat

Chat is an Agent Capability. Attach it to the discovered Agent; hosts and DevTools call its `chat.message` trigger through the Agent Trigger API.

```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'
import { chat } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [chat({ concurrency: 'queue' })],
  model,
})
```

Use the capability options to customize history.

```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'
import { chat } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [chat({ concurrency: 'queue', history: { source: 'thread', maxMessages: 20 } })],
  model,
})
```

## Use Workspace capabilities

Use `defineAgent()` with a `workspace` option from a colocated agent config when an agent answers from ViteHub Workspace sources. `workspace` mounts the sources only; it does not expose model tools by itself.

Add `workspaceShell()` when the model should inspect the mounted files:

```ts [server/agents/data-sources/config.ts]
import { defineAgent } from '@vitehub/agent'
import { workspaceShell } from '@vitehub/agent/capabilities'
import { source } from '@vitehub/workspace'

export default defineAgent({
  workspace: {
    sources: {
      docs: source.github({ repo: 'acme/docs', cache: { maxAge: 3600 } }),
    },
  },
  capabilities: [
    workspaceShell(),
  ],
  model,
})
```

`server/agents/<name>/config.ts` becomes both the agent definition and an implicit workspace definition. Workspace files are not loaded as model instructions by convention. If you want to use `AGENTS.md`, opt in explicitly and keep command syntax guidance out of the file; the workspace shell tool describes its supported syntax through adapter metadata.

```ts [server/agents/data-sources/config.ts]
export default defineAgent({
  workspace: {
    sources: {
      docs: source.github({ repo: 'acme/docs' }),
    },
  },
  capabilities: [
    workspaceShell(),
  ],
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model,
})
```

Instruction parts can also be composed with an array:

```ts
export default defineAgent({
  workspace: {},
  capabilities: [
    workspaceShell(),
  ],
  instructions: [
    'Answer only from inspected workspace evidence.',
    async ({ fs }) => await fs.readFile('AGENTS.md'),
  ],
  model,
})
```

### Migration note

Workspace sources do not imply model tools. Replace older workspace agents that relied on root or adapter-level tools with explicit capabilities:

```diff
 import { defineAgent } from '@vitehub/agent'
+import { workspaceShell } from '@vitehub/agent/capabilities'

 export default defineAgent({
   workspace: { sources },
+  capabilities: [
+    workspaceShell(),
+  ],
+  model,
 })
```

Use `workspaceShell({ mode: 'write' })` only with `workspace.mode: 'write'`. Raw tools should be wrapped in inline or factory capabilities.

## Use fetch capabilities

Use `fetch()` when the model should call declared read-oriented HTTP tools. It supports JSON and text resources in v1:

```ts [server/agents/status/config.ts]
import { defineAgent } from '@vitehub/agent'
import { fetch } from '@vitehub/agent/capabilities'
import { useServerEnv } from '#vitehub/env/server'

export default defineAgent({
  capabilities: [
    fetch({
      tools: {
        checkRegionStatus: {
          description: 'Fetch current service status for a region.',
          request: ({ region }) => {
            const env = useServerEnv()
            return {
              url: 'https://status.example.com/api/region',
              query: { region },
              headers: {
                authorization: `Bearer ${env.status.token.unseal()}`,
              },
            }
          },
          responseType: 'json',
        },
      },
    }),
  ],
  model,
})
```

The fetch Capability is query-only. Use it for stable read-style `GET`, `HEAD`, and `POST` requests; side-effectful API calls need a separate Capability design with explicit policy.

## Use durable memory

Memory stores expose scoped records through model tools. Configure at least one explicit scope value so records do not bleed across tenants, projects, users, or agents.

```ts [server/agents/support.ts]
import { defineAgent } from '@vitehub/agent'
import { memory, workspaceJsonlMemoryStore } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [
    memory({
      stores: {
        agent: {
          adapter: workspaceJsonlMemoryStore(),
          read: {
            preload: [{ kind: 'procedural', pinned: true }],
          },
          scope: { agent: 'support' },
          write: { mode: 'tool', policy: 'require-approval' },
        },
      },
    }),
  ],
  model,
})
```

The default JSONL file is `.vitehub/memory.jsonl`. Pass `workspaceJsonlMemoryStore({ path })` to choose another workspace path.

When tools omit `store`, memory uses the `agent` store if it exists, or the only configured store. If multiple non-`agent` stores are configured, tool calls must pass `store` explicitly.

Read permissions are enforced per selected store. A store with `read.tools.search: false` or `read.tools.read: false` cannot be reached through that tool even when another store exposes it.

Thread IDs are recorded in memory provenance for writes, but they are not added to the record scope automatically. Add thread scoping explicitly when records should be isolated per chat thread:

```ts
memory({
  stores: {
    agent: {
      adapter: workspaceJsonlMemoryStore(),
      scope: context => ({ agent: 'support', thread: context.run?.threadId }),
    },
  },
})
```
