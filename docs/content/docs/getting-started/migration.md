---
title: Migrate to vite-hub
description: Move an existing ViteHub application to the canonical framework package without losing owner-package escape hatches.
navigation.order: 5
icon: i-lucide-route
---

Use this guide when an application imports `vitehub()` from `@vite-hub/vite`
or declares several `@vite-hub/*` application dependencies. Libraries and
focused integrations can keep using owner packages directly.

## What changes

New applications install `vite-hub`, import `vitehub()` from the package root,
and use intentional feature subpaths for application APIs. The root does not
become a barrel of every ViteHub API.

| Existing import | Canonical application import |
| --- | --- |
| `@vite-hub/vite` | `vite-hub` |
| `@vite-hub/agent` | `vite-hub/agent` |
| `@vite-hub/agent/capabilities` | `vite-hub/agent/capabilities` |
| `@vite-hub/env` | `vite-hub/env` |
| `@vite-hub/workspace` | `vite-hub/workspace` |
| `@vite-hub/workflow` | `vite-hub/workflow` |

`@vite-hub/vite` remains a supported root-only compatibility import for
`vitehub()`. It does not expose `@vite-hub/vite/*` feature paths. Every owner
package remains independently installable and supported. Applications that
temporarily keep this import must still install `vite-hub` directly so generated
framework imports resolve from the application root.

## Migrate an application

1. Add the framework distribution.

   ```bash [Terminal]
   pnpm add vite-hub
   ```

2. Move the Vite Integration to the canonical root import.

   ```ts [vite.config.ts]
   import { defineConfig } from 'vite'
   import { vitehub } from 'vite-hub'

   export default defineConfig({
     plugins: [vitehub()],
   })
   ```

3. Move normal application imports to feature subpaths.

   ```ts [server/agents/support.ts]
   import { defineAgent } from 'vite-hub/agent'
   import { access } from 'vite-hub/agent/capabilities'
   import { defineWorkspace } from 'vite-hub/workspace'
   ```

4. Remove direct ViteHub dependencies only after no source file imports them.
   Keep any owner package used for an advanced provider, host, test, or direct
   integration path.

Third-party model providers, chat adapters, and harness packages stay explicit
dependencies. Workflow retains its documented Vercel Functions runtime default,
while other provider SDKs remain package-owned and explicit.

## Verify the migration

Install from the updated manifest, typecheck, build, and run the application's
smallest runtime proof.

```bash [Terminal]
pnpm install
pnpm exec tsc --noEmit
pnpm vite build
```

Inspect `package.json` and the lockfile to confirm that `vite-hub` is the only
direct ViteHub dependency intended for the application. Existing owner-package
imports remain a safe rollback path because those packages continue to ship
independently.

## Related

- [Installation](/docs/getting-started/installation)
- [Import paths](/docs/reference/import-paths)
- [Package reference](/docs/reference)
