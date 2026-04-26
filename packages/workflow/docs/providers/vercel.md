---
title: Vercel
description: Configure @vitehub/workflow for Vercel.
icon: i-simple-icons-vercel
---

Vercel is the default workflow provider when hosting is not Cloudflare:

```ts
export default defineConfig({
  plugins: [hubWorkflow()],
  workflow: {},
})
```

The Vite build emits a Vercel Build Output server function that keeps the `@vitehub/workflow` runtime API available to server routes.
