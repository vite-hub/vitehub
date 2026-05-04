---
title: Cloudflare Workspace Compatibility
description: How @vitehub/workspace maps to Cloudflare storage and execution primitives.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

`@vitehub/workspace` supports Cloudflare Artifacts as the hosted v1 workspace store and Cloudflare Sandbox as the executable workspace runtime. Cloudflare support keeps storage and execution roles separate:

| Cloudflare primitive | Intended role |
| --- | --- |
| Artifacts | Canonical versioned file-tree store. |
| R2 | Large-object spillover for workspace stores. |
| Sandbox | Isolated execution when commands, compilers, or full OS access are needed. |

Cloudflare Artifacts stores versioned file trees behind a Git-compatible interface. On Cloudflare Nitro builds, registering the module is enough for ViteHub to use the default Artifacts binding and emit the generated Wrangler config.

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro', '@vitehub/workspace/nitro'],
  sandbox: {
    provider: 'cloudflare',
    binding: 'SANDBOX',
    sandboxId: 'app-sandbox',
  },
})
```

The default Cloudflare store uses binding `WORKSPACE_ARTIFACTS`, namespace `vitehub`, branch `main`, and repository names generated from `vitehub-workspace-` plus the workspace name. Use environment variables or explicit store options only when those defaults need to change.

Use `runtime: 'sandbox'` on the workspace definition to make `workspace.open()` materialize that workspace into Cloudflare Sandbox at runtime:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from '@vitehub/workspace'

export default defineWorkspace({
  store: { provider: 'cloudflare-artifacts' },
  runtime: 'sandbox',
  sources: {
    // ...
  },
})
```

```ts
import { useWorkspace } from '@vitehub/workspace'

const session = await useWorkspace('docs', { allowWrite: true }).open()

await session.exec('pnpm', ['test'])
await session.commit()
await session.close()
```

Cloudflare-specific capabilities such as `runCode`, `exposePort`, `mountBucket`, `createBackup`, and `restoreBackup` stay on provider extras. The portable workspace session keeps the shared `exec`, `diff`, `commit`, and `close` shape.

`close()` does not destroy the configured Cloudflare sandbox. It only marks the workspace session closed; Cloudflare lifecycle policy stays controlled by the app-level sandbox config and provider settings.

The public API remains source-oriented:

```ts
import * as source from '@vitehub/workspace/source'

source.github({
  repo: 'acme/app',
  ref: 'main',
  root: 'docs',
})
```

Hosted Cloudflare providers should keep Artifacts, R2, and Sandbox as implementation details behind the workspace store/runtime adapters.
