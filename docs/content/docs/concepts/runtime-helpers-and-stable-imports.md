---
title: Runtime Helpers and stable imports
description: Learn how application code calls ViteHub primitives without importing generated internals.
navigation.order: 6
icon: i-lucide-code-2
---

A Runtime Helper is a runtime API used by application code to call, inspect, or use a configured ViteHub primitive. Stable ViteHub import paths keep application code independent from Provider Output, virtual modules, and generated file locations.

## Why it exists

Generated output changes with provider, host, package options, and deployment target. Server code should not need those details to call KV, read a Workspace, run an Agent, or access Server Env.

Stable imports also make docs and agent instructions actionable. An agent can search for one documented import instead of guessing provider-specific modules.

## Examples

Use a package Runtime Helper from server code.

```ts [server/api/settings.get.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get('settings')
  if (error) throw error
  return { settings }
})
```

Use a generated stable import only when the package documents it.

```ts [server/secrets.ts]
import { useServerEnv } from '#vitehub/env/server'

export function getGithubToken() {
  return useServerEnv().github.token.unseal()
}
```

Run an Agent through the Agent Package instead of calling generated route code.

```ts [server/api/support.post.ts]
import { runAgent } from '@vite-hub/agent'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  return runAgent(support, { runtime: 'vite' }, await readBody(event))
})
```

## When to use what

| Surface | Use it from app code? | Why |
| --- | --- | --- |
| Package Runtime Helper | Yes | It is the stable public runtime API. |
| `#vitehub/...` stable generated import | Yes, when documented | It hides generated file paths behind a ViteHub-owned import. |
| Framework virtual module | No, unless documented | It exposes integration detail. |
| Raw `.vitehub` file path | No | It is Provider Output or generated backing state. |
| Provider SDK or binding | Only inside provider-specific code | It bypasses the ViteHub primitive boundary. |

## Inspect it

Search for imports from `@vite-hub/*`, `@vite-hub/*/vite`, and documented `#vitehub/...` paths. Those imports show where the public boundary is.

## Next steps

- Read [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output).
- Try [First server primitive](/docs/getting-started/first-server-primitive).
- Open [Env](/docs/server-primitives/env) for a generated stable import example.
