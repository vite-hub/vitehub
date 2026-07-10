---
title: Agent instructions and skills
description: Separate repo-local coding-agent guidance from public ViteHub product docs.
navigation.order: 63
icon: i-lucide-scroll-text
---

Agent instructions and skills guide coding agents that edit this repository.
They are not public product APIs, and they should not leak into ViteHub runtime docs.

## Current sources

| Source | Status | Use |
| --- | --- | --- |
| `AGENTS.md` | Available in the repo | Repo-level instructions for agents editing ViteHub. |
| Public ViteHub skill | Implemented | Install with `npx skills add https://vitehub.dev`; the skill points agents to server primitives, Agent Definitions, `llms.txt`, and raw Markdown routes. |
| Public agent instruction bundle | Not implemented | Product behavior belongs in the public docs pages. |

## Boundary

Repository-specific agent guidance belongs in `AGENTS.md`.
Public docs should summarize the stable product behavior and link to implemented APIs instead of exposing every internal development note.

## Audience split

Any future public affordance should separate three audiences.

| Audience | Needs |
| --- | --- |
| Agents editing this repo | Read `AGENTS.md`, then inspect the current source and relevant public docs. |
| Agents building apps with ViteHub | Read product docs for server primitives, Agents, package references, examples, and AI resource indexes. |
| Agents embedded in ViteHub apps | Read application-provided Agent Instructions with explicit coverage for Sources, Capabilities, and Skills. |

## Use with Agent Definitions

Application Agent Instructions are runtime product behavior.
They are not the same as repo instructions for coding agents.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model,
    instructions: [
      'Answer from connected Workspace Sources first.',
      'Use configured Sources, Capabilities, and Skills only for the roles named in these instructions.',
    ].join('\n\n'),
  },
})
```

## Next steps

- Install the public skill with `npx skills add https://vitehub.dev`.
- Use [llms.txt](/docs/ai-resources) for public docs discovery when a skill is not installed.
- Use [Markdown pages](/docs/ai-resources/markdown-pages) for full page source.
- Use [Instructions](/docs/agents/instructions) for Agent Definition instruction behavior.
