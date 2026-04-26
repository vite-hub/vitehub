---
title: Cloudflare
description: Configure @vitehub/workflow for Cloudflare Workflows.
icon: i-simple-icons-cloudflare
---

Cloudflare hosting selects the Cloudflare provider automatically:

```ts
export default defineConfig({
  plugins: [hubWorkflow()],
  workflow: {},
})
```

The Vite build emits `wrangler.json` workflow bindings for discovered workflow definitions.
