---
title: Workflow
description: Run portable workflows from ViteHub apps on Cloudflare and Vercel.
---

`@vitehub/workflow` provides a small workflow API for Vite apps that need to start and observe named background workflows.

```ts
import { runWorkflow } from '@vitehub/workflow'

await runWorkflow('welcome', {
  email: 'ava@example.com',
})
```

Register the Vite plugin:

```ts
import { hubWorkflow } from '@vitehub/workflow/vite'

export default defineConfig({
  plugins: [hubWorkflow()],
  workflow: {},
})
```
