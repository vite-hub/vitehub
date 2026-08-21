---
title: Browser
description: Give a Provider Agent headless browser guidance.
navigation.title: Browser
navigation.order: 62
navigation.group: Workspace
icon: i-lucide-monitor
---

`browser()` mounts an inspectable browser Skill at `skills/browser/SKILL.md` for a Provider Agent. The matching CLI must already be available to the provider process.

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'
import { browser } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: 'codex',
  workspace: { mode: 'write' },
  capabilities: [browser()],
})
```

The Skill tells the provider to use `agent-browser` through its native command tools and save screenshots inside the Workspace. ViteHub does not install the CLI or add a parallel shell tool. Model-backed and custom Drivers fail explicitly because they do not own the required provider command loop.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `string` | `"agent-browser"` | Executable name named in the Skill. |
| `skillContent` | `string` | built-in browser Skill | Markdown content for the mounted Skill. |
| `skillPath` | `string` | `"skills/browser/SKILL.md"` | Workspace path for the Skill. |
| `sourceKey` | `string` | `"skill.browser"` | Workspace Source key for the Skill file. |

Use the [Browser primitive](/docs/server-primitives/browser) when trusted server code should own Browser Session lifecycle.
