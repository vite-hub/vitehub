---
title: Channels
description: Connect an Agent to web chat and messaging platforms without mixing transport with identity.
navigation.order: 40
navigation.group: Connect
icon: i-lucide-radio
---

A Channel describes where an Agent Invocation came from and how replies return there. It carries transport, event, thread, message, and delivery facts. It does not prove who the caller is.

Use [Agent Actors](/docs/agents/actors) for trusted identity and [Input Commands](/docs/capabilities/input-commands) for explicit command handling.

## Add a Channel

Import Channel helpers from `@vite-hub/agent/channels`.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { github, webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    portal: webChat(),
    github: github({ pullRequest: true }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

Built-in helpers include `discord()`, `github()`, `http()`, `slack()`, `teams()`, `telegram()`, and `webChat()`. Use `defineChannel()` for an application-owned Channel Kind.

`webChat()` enables a generated AI SDK chat route by default. `http()` is a generic HTTP Channel and keeps its route disabled unless you pass `http({ route: true })`.

## Connect a web chat

`webChat()` exposes the Agent through `/api/_vitehub/agents/[agent]/chat`. Set `route: false` to keep that Agent unreachable through the shared dispatcher.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'node', agent: true }),
  ],
})
```

Use the Vue client from the application:

```vue [app/components/SupportChat.vue]
<script setup lang="ts">
import { useAgent, useChat } from 'vite-hub/agent/vue'

const agent = useAgent('support')
const { messages, status, sendMessage, stop } = useChat(agent)
</script>
```

Add `route.admission.authenticate` when the generated route needs authentication. ViteHub reads the raw body once, verifies the shared UI-message contract, and copies only fields named in `route.input.trust` after authentication.

Agent chat and webhook routes accept at most 1 MiB by default. Set `route.maxBodyBytes` to a smaller limit or raise it as high as 10 MiB for a web chat with larger JSON payloads. ViteHub checks `Content-Length` and the streamed byte count, so chunked requests cannot bypass the limit.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    portal: webChat({
      route: {
        admission: {
          authenticate({ rawBody, request }) {
            verifyPortalSignature(rawBody, request.headers.get('x-portal-signature'))
            return { customer: request.headers.get('x-customer') }
          },
        },
        input: { trust: ['meta', 'user', 'session'] },
      },
    }),
  },
  driver: { run: () => 'ok' },
})
```

Use an application-owned route and [`streamAgentTrigger()`](/docs/agents/triggers#consume-a-capability-trigger) when the shared dispatcher is not the right authentication or request boundary.

### Resume a web chat in one process

Set `resume: true` in `useChat()` and opt the generated route into process-scoped replay when a browser should follow an active response after reconnecting.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { webChat } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    portal: webChat({
      route: {
        admission: {
          authenticate: ({ request }) => requireSession(request),
        },
        resumable: {
          owner: ({ auth }) => auth.user.id,
          scope: 'process',
          ttlMs: 10 * 60 * 1000,
        },
      },
    }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

The route de-duplicates one owner's repeated submission, replays buffered UI-message stream bytes, follows the live response, and retains a completed response for `ttlMs`. `scope: 'process'` is literal: active streams do not survive process replacement and cannot be discovered by another instance. Use this only where deployment keeps a chat on one process, or put durable execution, stream storage, and coordination behind an application-owned route.

## Connect an adapter platform

Adapter-backed Channels deliver the completed response by default. Set Agent-level `messages.stream: true` to publish draft and edit updates everywhere, or set `messages.stream` on one Channel.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { discord } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    discord: discord({
      adapter: {
        botToken: process.env.DISCORD_BOT_TOKEN,
        publicKey: process.env.DISCORD_PUBLIC_KEY,
      },
      messages: { lockScope: 'thread' },
    }),
  },
  driver: { run: () => 'Hello from ViteHub.' },
})
```

Install the matching `@chat-adapter/*` package when a built-in Channel uses provider adapter options. Keep provider credentials in Server Env.

For Telegram, ViteHub can own the verified webhook route and synchronize it after deployment:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  channels: {
    telegram: { allowedUserIds: ['123'] },
  },
  driver: { run: () => 'Hello from ViteHub.' },
})
```

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --agent support \
  --channel telegram \
  --json
```

The command is a dry run by default. Apply a reviewed plan with `--apply` and the exact `--confirm-origin`; see [CLI channel synchronization](/docs/development/cli#synchronize-channel-webhooks) for deletion and secret safeguards.

## Control admission and delivery

Set `messages.filter` to ignore unsupported adapter messages before an invocation starts:

```ts
teams({
  adapter,
  messages: {
    filter: ({ deliveryKind }) =>
      deliveryKind === 'direct' || deliveryKind === 'mention',
  },
})
```

`deliveryKind` is `direct`, `mention`, or `subscribed`. Returning `false` posts no fallback error because the Agent never started.

Set `messages.commentary: 'message'` only when the Driver emits explicit commentary phases for public progress. Commentary is hidden by default; ViteHub never publishes reasoning as progress.

Use `messages.delivery: 'manual'` when finish hooks own replies. A generated Workflow may carry manual delivery across a durable boundary when the Channel and host support it. An explicit `messages.timeout` bounds inline execution and the durable handoff's typing indicator, but it does not cap the durable Agent Workflow. `steer` queues overlapping messages and preserves that Workflow handoff. Other overlap policies such as `serial`, `drop`, `queue`, and `reject` remain inline and cannot be combined with required durable delivery.

## Inspect delivery custody

Every built-in and custom Agent Channel records a delivery timeline before the Agent starts. The record keeps the provider event id separate from ViteHub's delivery id, then appends admission, invocation, retry, outbound, completion, and failure events. Discord Gateway and Telegram polling listeners also emit structured lifecycle events, so a listener gap can be distinguished from an event that reached ViteHub.

The evidence boundary stays explicit: no ViteHub record can prove a provider event existed when it never reached the process. Provider audit logs and Gateway session history remain the source for that side of an incident.

The journal uses the Channel's existing State Adapter and retains the timelines referenced by the 10,000 most recent admissions. Inspection de-duplicates concurrent or retried admissions of the same timeline. Each delivery and its newest 256 events expire 30 days after their last update. Records contain identifiers, timestamps, attempts, provider reply ids, and bounded error messages; ViteHub does not copy message text, attachment data, webhook bodies, or connector options into the journal. Production durability therefore follows the configured Agent state provider, while the default in-memory development state remains process-local.

Invocation hooks and Drivers receive the active record as `context.channelDelivery`. Trace Events repeat `channel.delivery.id`, `channel.delivery.provider`, and `channel.delivery.source.id`, while JSON logs use the `vitehub.channel.delivery` and `vitehub.channel.listener` scopes. The webhook route handler exposes `handler.deliveries(request, webhookId, options)` so host integrations inspect records through the same scoped State Adapter used by the Channel.

## Scope abilities to one Channel

Channel Capabilities apply only when that Channel is active. Agent-level Capabilities remain available to every invocation.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { openapi } from 'vite-hub/agent/capabilities'
import { teams, webChat } from 'vite-hub/agent/channels'

const portalApi = openapi({
  cli: { name: 'portal-api' },
  operations: ['purchaseOrders'],
  spec: 'https://portal.example.com/_openapi.json',
})

export default defineAgent({
  channels: {
    portal: webChat({ capabilities: [portalApi] }),
    teams: teams(),
  },
  driver: { run: () => 'ok' },
})
```

Channel-scoped Capabilities select abilities, not identity. Authenticate and resolve the Actor at the route, trigger, or `access()` boundary.

## Handle attachments

Adapter Channels preserve incoming images, audio, and files as typed message parts. Normalization can fetch a URL-only text attachment on the server to produce text bytes. It does not call lazy provider callbacks, write local files, or persist blobs.

Model-backed Drivers can consume inline data, adapter-owned `fetchData`, and HTTPS references within one invocation-wide byte budget. The default is 25 MiB; set `driver.execution.attachments.maxBytes` to lower it. Image, audio, and file HTTPS references are forwarded, but URL-only text attachments use the runtime's server-side `fetch()` without built-in scheme or host restrictions. Treat adapter-supplied text URLs as an SSRF boundary: reject untrusted URLs or validate them against an application-owned allowlist or fetch proxy before they reach normalization.

Channel history export archives inline data, size-declared adapter-owned `fetchData`, and Blob data within a 25 MiB total attachment budget and a 35 MiB total response budget. Lazy adapter reads need a trustworthy non-negative `size` within the remaining budget. URL-only attachments remain unavailable references because the Agent server cannot infer an application-owned host trust policy safely. Persist their bytes through the adapter when they must be recoverable. The export stops waiting for each provider history read or adapter-owned read after 30 seconds or when its request is aborted. The Chat SDK history and `fetchData` contracts have no cancellation channel, so their underlying private I/O remains adapter-owned and may settle after the export stops waiting. Attachments that exceed the remaining budget, contain malformed retained data, fail rehydration, omit the size required for a lazy read, or otherwise cannot be read remain in `history.json` as unavailable references. The export fails instead of building an archive above its total response limit.

Provider-backed Drivers materialize inline data and application-owned `fetchData` results. URL-only attachments require the application to validate and resolve the URL through `fetchData` before crossing the provider boundary; the Driver does not fetch arbitrary URLs from the ViteHub host.

## Separate responsibilities

| Concern | Owner |
| --- | --- |
| Origin, event, thread, message, custody, and reply delivery | Channel |
| Trusted caller identity | Agent Actor |
| User-authored command parsing | Input Commands Capability |
| Prior conversational messages | Chat History and sessions |
| Product event to Agent input | Trigger |
