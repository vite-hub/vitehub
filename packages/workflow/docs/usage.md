---
title: Usage
description: Define and run workflows with ViteHub.
---

Create workflow definitions in `server/workflows`:

```ts
import { defineWorkflow } from '@vitehub/workflow'

export default defineWorkflow(async ({ payload }) => {
  return { ok: true, payload }
})
```

Start a workflow from server code:

```ts
import { runWorkflow } from '@vitehub/workflow'

const run = await runWorkflow('welcome', { email: 'ava@example.com' })
```

Use `deferWorkflow()` when the runtime should start the workflow in `waitUntil()`.
