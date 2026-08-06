---
title: Definition discovery
description: "Understand how ViteHub turns portable declarations into named, inspectable runtime entries."
navigation.group: Core vocabulary
navigation.order: 10
icon: i-lucide-file-code-2
---

A Definition is a portable declaration for named work or state. Discovery is the package rule that finds that declaration and gives it a stable runtime identity.

ViteHub usually derives the identity from the declaration's location, so the same file can be registered, inspected, and invoked consistently across hosts.

## Location gives a Definition its name

```txt
server/agents/support.ts      -> support
server/agents/docs/agent.ts   -> docs
src/triager.agent.ts          -> triager
```

The package that owns the Definition documents its discovery locations and exceptions. A `name` option can affect the Definition's display or explicit runtime behavior, but it does not automatically replace the discovery key.

## Discovery is a build boundary

The Vite Integration reads Definition files and prepares generated registries, routes, bindings, or imports. Runtime code consumes the resulting stable surface; it should not import generated registry internals directly.

Definitions that need build-extracted options should export the package helper directly from the discovered file.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run: () => 'ok',
  },
})
```

## Inspect the result

Inspect the source file, the generated `.vitehub` metadata, and the CLI or runtime surface that consumes the discovered name. If those disagree, fix the package discovery rule or Definition location instead of adding an application-side id.

Read [Agent definitions](/docs/agents/agent-definitions) for Agent-specific declarations and [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) for the host side of discovery.
