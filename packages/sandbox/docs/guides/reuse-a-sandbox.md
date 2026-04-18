---
title: Reuse a sandbox
description: Control sandbox identity with sandboxId when the provider supports sandbox reuse.
navigation.title: Reuse a sandbox
navigation.group: Guides
---

Some Sandbox providers can reuse the same underlying runtime identity across calls. Use `sandboxId` when repeated runs should attach to the same provider-managed sandbox instead of creating a fresh one.

## Set a stable sandbox id in config

Use top-level `sandbox.sandboxId` when most executions for that app should reuse the same identity.

::fw{#vite}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

export default defineConfig({
  plugins: [hubSandbox()],
  sandbox: {
    provider: 'cloudflare',
    sandboxId: 'release-notes',
  },
})
```
::

::fw{#nitro #nuxt}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: {
    provider: 'cloudflare',
    sandboxId: 'release-notes',
  },
})
```
::

## Override sandbox identity per run

Use `runSandbox(..., { sandboxId })` when only one execution path should reuse an existing runtime.

```ts
import { runSandbox } from '@vitehub/sandbox'

await runSandbox('release-notes', {
  notes: '- Added weekly digest',
}, {
  sandboxId: 'repo-acme-docs',
})
```

## When to use reuse

Reach for `sandboxId` when:

- the provider should preserve runtime identity between requests
- repeated calls should hit the same provider-managed sandbox
- the work benefits from provider-side warm reuse

Avoid it when every execution should stay ephemeral and isolated from previous runs.

## Provider notes

- Cloudflare Durable Objects can reuse sandbox identity with `sandboxId`.
- Vercel may model reuse differently depending on the sandbox runtime.

## Related pages

- [Run a sandbox](./run-a-sandbox)
- [Cloudflare](../providers/cloudflare)
- [Vercel](../providers/vercel)
