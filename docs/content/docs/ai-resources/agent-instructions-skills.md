---
title: Agent instructions and skills
description: Plan how ViteHub exposes repo instructions and agent skills as AI-readable docs affordances.
navigation.order: 63
icon: i-lucide-scroll-text
---

Agent instructions and skills are planned docs affordances for agents working on or with ViteHub.
They should point agents to the right repo guidance without mixing development-only instructions into public product API pages.

## Current sources

| Source | Status | Use |
| --- | --- | --- |
| `AGENTS.md` | Available in the repo | Repo-level instructions for agents editing ViteHub. |
| `.agents/domain.md` | Available in the repo | How agents should consume domain docs. |
| `.agents/CONTEXT-MAP.md` | Available in the repo | Map from work topics to context glossaries. |
| `.agents/contexts/**/CONTEXT.md` | Available in the repo | Domain vocabulary and ownership boundaries. |
| Public docs skill index | Planned | AI-readable mapping from docs tasks to guidance. |
| Public agent instruction bundle | Planned | Curated instructions for agents using ViteHub, not editing the repo. |

## Boundary

Development-only agent guidance belongs under `.agents/`.
Public docs should summarize the stable product behavior and link to implemented APIs instead of exposing every internal development note.

## Planned docs affordance

The public affordance should separate three audiences.

| Audience | Needs |
| --- | --- |
| Agents editing this repo | Read `AGENTS.md`, `.agents/domain.md`, and the relevant context glossary. |
| Agents building apps with ViteHub | Read product docs, package references, examples, and AI resource indexes. |
| Agents embedded in ViteHub apps | Read application-provided Agent Instructions, Source Instructions, and Capability-owned guidance. |

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
      '{{ workspace.sources }}',
      '{{ capabilities }}',
    ].join('\n\n'),
  },
})
```

## Next steps

- Use [llms.txt](/docs/ai-resources) for public docs discovery.
- Use [Markdown pages](/docs/ai-resources/markdown-pages) for full page source.
- Use [Instructions](/docs/agents/instructions) for Agent Definition instruction behavior.
