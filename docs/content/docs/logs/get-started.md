---
title: Get started
navigation.title: Get started
navigation.order: 2
description: Get started for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

Install Evlog in your application:

```sh
pnpm add evlog
```

Enable local capture in a Vite application with Nitro 3:

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'node', logs: true, console: { auth: false, local: true } }),
    nitro(),
  ],
})
```

Enrich the automatic request event through Evlog's framework adapter:

```ts [server/api/status.get.ts]
import { useLogger } from 'evlog/nitro/v3'
import { defineHandler } from 'nitro/h3'

export default defineHandler((event) => {
  useLogger(event).set({ message: 'Status checked', deployment: { environment: 'development' } })
  return { ok: true }
})
```

Start your dev server, request `/api/status`, then open `/_vitehub/logs`. Select a row to inspect its structured data. Switch between Explorer and Stream. Follow polls for new events.

Use the official `evlog/nitro` adapter for Nuxt with Nitro 2. In Nuxt, pass `logs: true` to the `vite-hub/nuxt` module options.

The repository's `playground/logs` includes a checkout request, redaction, and a serialized Nostics diagnostic. Follow its README to run the example.

Local capture is development only. For production, configure an [existing backend source](/docs/logs/configure#read-an-existing-backend).
