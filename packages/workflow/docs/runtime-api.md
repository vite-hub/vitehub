---
title: Runtime API
description: Runtime functions exported by @vitehub/workflow.
---

Runtime code imports from `@vitehub/workflow`:

```ts
import {
  defineWorkflow,
  deferWorkflow,
  getWorkflowRun,
  runWorkflow,
} from '@vitehub/workflow'
```

Vite config imports the plugin from `@vitehub/workflow/vite`:

```ts
import { hubWorkflow } from '@vitehub/workflow/vite'
```

The Vite plugin discovers definitions from `server/workflows/**` and `*.workflow.ts`.
