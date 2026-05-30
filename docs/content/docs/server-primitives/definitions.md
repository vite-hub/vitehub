---
title: Definitions and discovery
description: Understand how ViteHub discovers named work and turns it into runtime registries.
navigation.title: Definitions
navigation.order: 2
icon: i-lucide-file-code-2
---

A **Definition** is a portable declaration of work or state. It names what should exist without tying application code to one host runtime.

Definitions are used by primitives that need named work:

- Database schemas.
- Workspaces.
- Queues.
- Workflows.
- Schedules.
- Sandboxes.
- Agents.

## Discovery identity

When ViteHub discovers a Definition, the discovered name comes from the file location. The name does not come from an arbitrary inline option.

```txt
server/
  queues/
    welcome-email.ts        -> welcome-email
  workflows/
    onboard-user.ts         -> onboard-user
  agents/
    support/
      triage.ts             -> support/triage
```

This makes generated registries predictable and keeps names stable across build, dev, and generated host output.

## Boundary helpers

Definition files should default-export the helper that owns the boundary.

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vite-hub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  await sendWelcomeEmail(job.payload.email)
})
```

The helper validates the declaration and lets the integration generate the correct Runtime Registry or host output.

## Runtime Helpers

Runtime Helpers are what application code calls after discovery.

```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)
  return runQueue('welcome-email', body)
})
```

Application code should import through stable ViteHub paths. It should not import generated files or host virtual modules directly.

## Host output

Host output is generated deployment or runtime configuration required by a host. It can include bindings, generated functions, cron entries, queue consumers, or runtime imports.

Host output belongs to the primitive that needs it. It is documented inside the feature page instead of as a separate docs category.
