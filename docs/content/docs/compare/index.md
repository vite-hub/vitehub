---
title: Compare ViteHub primitives
description: Choose between ViteHub capabilities, orchestrators, interfaces, and shared state.
navigation.title: Compare primitives
icon: i-lucide-scale
---

ViteHub packages solve different server-side jobs. Pick the primitive by the shape of the work first, then choose the provider page for your deployment target.

Use this page when you are deciding whether a feature should store state, store files, run outside the response path, run in isolation, coordinate a model loop, expose a chat interface, or stay inline in the request.

For the architecture behind these boundaries, read [ViteHub philosophy](../philosophy).

## Pick by outcome

| You need to | Use | Why |
| --- | --- | --- |
| Read or write small JSON-like values by key | KV | The route needs fast key-based state without provider SDK code. |
| Accept, store, list, or stream files | Blob | The data is a file, stream, binary body, or object with metadata. |
| Return before background work finishes | Queue | The request should enqueue work and let the provider deliver it outside the response path. |
| Coordinate durable steps, waits, retries, or resumable work | Workflow | The work needs orchestration beyond one request or one model call. |
| Run user-defined or risky code behind an isolated boundary | Sandbox | The work needs an execution boundary and a result payload. |
| Run a model/tool loop | Agent | The feature needs model instructions, tools, and ViteHub message input. |
| Receive and respond to chat platform events | Chat | The feature needs Chat SDK adapters, webhook handling, and conversation state. |
| Persist conversation or stream state across interfaces | Messages | Agent and chat need the same serializable message/event model. |
| Finish a small amount of work before responding | Inline request code | The work is quick, reliable, and belongs to the response path. |
| Query relationships, joins, transactions, or history | A database | The data has a relational or durable application model. |

::callout{icon="i-lucide-info" color="info"}
Choose the primitive for the runtime behavior you need. Provider setup comes after that choice: Cloudflare and Vercel pages explain bindings, tokens, buckets, topics, and deployment-specific checks.
::

## Package fit

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: KV
  description: Store small values, settings, cache entries, flags, and lookup tables by key.
  icon: i-lucide-database-zap
  to: ../kv
  ---
  :::
::

::fw{id="vite:dev vite:build"}
::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: DB
  description: Model relational app data with a default Drizzle database and optional named databases.
  icon: i-lucide-database
  to: ../db
  ---
  :::
  :::u-page-card
  ---
  title: Blob
  description: Store uploads, generated assets, exports, images, and other file-shaped data.
  icon: i-lucide-files
  to: ../blob
  ---
  :::
  :::u-page-card
  ---
  title: Queue
  description: Send emails, fan out webhook handling, run post-response work, and rely on provider delivery.
  icon: i-lucide-list-ordered
  to: ../queue
  ---
  :::
  :::u-page-card
  ---
  title: Workflow
  description: Run durable server orchestration with resumable state and provider-backed execution.
  icon: i-lucide-git-branch
  to: ../workflow
  ---
  :::
  :::u-page-card
  ---
  title: Sandbox
  description: Execute isolated jobs such as code evaluation, report generation, transforms, and agent tools.
  icon: i-lucide-box
  to: ../sandbox
  ---
  :::
  :::u-page-card
  ---
  title: Agent
  description: Define model and tool-loop agents that consume canonical ViteHub messages.
  icon: i-lucide-bot
  to: ../agent
  ---
  :::
  :::u-page-card
  ---
  title: Chat
  description: Connect Chat SDK adapters, webhook routes, state, and optional agent handoff.
  icon: i-lucide-message-circle
  to: ../chat
  ---
  :::
  :::u-page-card
  ---
  title: Messages
  description: Share serializable message and stream-event state between chat, agent, and interfaces.
  icon: i-lucide-messages-square
  to: ../messages
  ---
  :::
::
::

::fw{id="nitro:dev nitro:build"}
::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Blob
  description: Store uploads, generated assets, exports, images, and other file-shaped data.
  icon: i-lucide-files
  to: ../blob
  ---
  :::
  :::u-page-card
  ---
  title: Queue
  description: Send emails, fan out webhook handling, run post-response work, and rely on provider delivery.
  icon: i-lucide-list-ordered
  to: ../queue
  ---
  :::
  :::u-page-card
  ---
  title: Workflow
  description: Run durable server orchestration with resumable state and provider-backed execution.
  icon: i-lucide-git-branch
  to: ../workflow
  ---
  :::
  :::u-page-card
  ---
  title: Sandbox
  description: Execute isolated jobs such as code evaluation, report generation, transforms, and agent tools.
  icon: i-lucide-box
  to: ../sandbox
  ---
  :::
  :::u-page-card
  ---
  title: Agent
  description: Define model and tool-loop agents that consume canonical ViteHub messages.
  icon: i-lucide-bot
  to: ../agent
  ---
  :::
  :::u-page-card
  ---
  title: Chat
  description: Connect Chat SDK adapters, webhook routes, state, and optional agent handoff.
  icon: i-lucide-message-circle
  to: ../chat
  ---
  :::
  :::u-page-card
  ---
  title: Messages
  description: Share serializable message and stream-event state between chat, agent, and interfaces.
  icon: i-lucide-messages-square
  to: ../messages
  ---
  :::
::
::

::fw{id="nuxt:dev nuxt:build"}
Only KV currently has Nuxt package docs. Blob, Queue, and Sandbox are documented for Vite and Nitro.
::

## Common decisions

| Decision | Choose this |
| --- | --- |
| Store a user avatar upload | Blob |
| Store the selected theme for a workspace | KV |
| Send a welcome email after signup | Queue |
| Run an onboarding process that waits for provider callbacks | Workflow |
| Generate release notes from a request payload in an isolated runtime | Sandbox |
| Answer a support question with tools and model instructions | Agent |
| Receive Slack, Discord, or Teams messages and respond in a thread | Chat |
| Save assistant stream events and replay them after reload | Messages |
| Increment a request-local counter before returning JSON | Inline request code |
| Store users, teams, permissions, and audit history | A database |

## Combine primitives

Many features use more than one primitive:

1. Store upload metadata in KV and the file body in Blob.
2. Accept a request, write a small status record to KV, then enqueue Queue work.
3. Run a Sandbox job, store its output in Blob, and save the latest result key in KV.
4. Let Chat adapt a direct message into Messages, then hand it to Agent.
5. Let Workflow coordinate a long-running Agent task that uses Sandbox as a scoped capability.

Keep the public route small. It should validate input, call the primitive that owns the work, and return a result the client can handle.

## Provider routing

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Configure bindings, buckets, queues, and sandbox provider requirements for Cloudflare deployments.
  icon: i-simple-icons-cloudflare
  to: ../providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure tokens, Upstash-backed KV, Vercel Blob, Vercel Queue, and Vercel Sandbox.
  icon: i-simple-icons-vercel
  to: ../providers/vercel
  ---
  :::
::
