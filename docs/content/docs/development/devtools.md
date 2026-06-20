---
title: DevTools
description: Inspect package-owned DevTools Features and Agent runtime state during Vite development.
navigation.order: 32
icon: i-lucide-panels-top-left
---

The ViteHub DevTools Client is the development inspection surface shared by ViteHub packages.
The DevTools Package owns the shell integration, and feature packages register their own DevTools Features and DevTools Bridges.

## Install the shell

Add the DevTools Package integration once.
Package integrations such as `hubAgent()` register their DevTools Feature when the package feature is enabled.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { hubDevtools } from '@vite-hub/devtools'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubDevtools(),
    hubAgent(),
  ],
})
```

## Inspect a feature

Open Vite DevTools while the Vite dev server runs.
The ViteHub panel loads the ViteHub DevTools Client and asks the DevTools Discovery Surface for registered features.

```bash [Terminal]
pnpm dev
```

For the Agent Package, inspect the Chat DevTools Feature when the Agent has a `chat.message` trigger.
The current bridge route is `/__vitehub/agent/chat/devtools`.

## Disable package DevTools

Disable a package-owned DevTools Feature from that package's Integration Options.
This keeps the runtime package active while hiding the development inspection surface.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({ devtools: false }),
  ],
})
```

## What to prove

| Question | DevTools proof |
| --- | --- |
| Did the feature register? | The ViteHub DevTools Client lists the DevTools Feature. |
| Can the client reach runtime state? | The DevTools Bridge returns state instead of a bridge error. |
| Did an Agent Invocation start from DevTools? | Agent Run Origin is `devtools`, and the trigger starts one Agent Invocation. |
| Did a Workspace-backed Agent expose files? | The feature shows the visible Workspace file tree or scoped source state. |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| ViteHub panel is missing | `hubDevtools()` is not installed. | Add `hubDevtools()` from `@vite-hub/devtools`. |
| Feature warning appears during dev | A package DevTools Feature is enabled without the shell integration. | Install the DevTools Package integration or disable the package feature. |
| Bridge returns malformed payload | The client and package bridge versions disagree. | Rebuild the package and restart the Vite dev server. |

## Next steps

- Use [Local development](/docs/development) for the broader proof map.
- Use [Runtime events](/docs/reference/runtime-events) for non-UI trace language.
- Use [Agent Evals](/docs/development/agent-evals) when behavior needs repeatable scoring.
