---
title: Instructions
description: Write durable model-facing behavior and policy for an Agent.
navigation.order: 31
navigation.group: Configure
icon: i-lucide-scroll-text
---

Instructions tell a model or harness how to behave. Keep tool schemas with Capabilities; use instructions for durable behavior, source policy, trust boundaries, escalation, and uncertainty handling.

## Start with a colocated document

Put longer guidance beside the Agent as `instructions.md`.

```md [server/agents/support/instructions.md]
# Support

Answer from inspected Workspace evidence before using outside knowledge.

When the docs do not answer the question, say that directly.
```

```ts [server/agents/support/agent.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
  },
  workspace: {
    sources: {},
  },
})
```

ViteHub parses instruction Markdown through Comark. A colocated document becomes the default for a model-backed Driver when `driver.instructions` is absent. Harness-backed Drivers receive the rendered document in their Workspace session as `AGENTS.md`, plus `CLAUDE.md` for Claude Code-compatible harnesses.

Use `driver.instructions` for short or invocation-specific text:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      'You are a support engineer.',
      'Answer from inspected evidence. State when evidence is missing.',
    ],
  },
})
```

## Split reusable guidance

Use static `@./path.md` imports when one document becomes difficult to scan.

```md [server/agents/support/instructions.md]
# Support

@./shared-style.md

@./escalation-policy.md
```

Imports are relative, recursive up to four levels, and processed like the parent document. Remote URLs, absolute paths, and globs fail instead of widening instruction reachability.

## Insert trusted invocation values

Read explicit `context.*` values with double braces for scalars and triple braces for trusted Markdown.

```md [server/agents/support/instructions.md]
Answer for {{ context.customerName }}.

{{{ context.supportPolicy }}}
```

The caller or a Capability must set these values before composition. Missing bindings fail instead of rendering empty text; templates cannot read arbitrary request fields, environment variables, or JavaScript expressions.

Use conditions for small policy branches:

```md [server/agents/support/instructions.md]
::if{condition="context.audience === 'technical'"}
Include implementation details and cite file paths.
::else
Prefer customer-facing language and next actions.
::
```

Conditions support `context.*` paths, scalar literals, equality, `&&`, `||`, `!`, and parentheses.

## Insert Workspace bindings

Declare values or Markdown files under `workspace.bindings`, then reference only those named bindings.

```ts [server/agents/support/agent.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      'Use {{ workspace.tone }} tone.',
      '@workspace.policy',
    ],
  },
  workspace: {
    bindings: {
      tone: 'short',
      policy: { path: 'policies/support.md' },
    },
  },
})
```

`@workspace.policy` inserts the declared Markdown and composes it again. ViteHub does not scan or auto-load every Markdown file in the Workspace.

## Cover configured primitives

Name how each configured Source, Capability, or Skill should be used. ViteHub records this coverage for inspection and warns when a configured primitive has no explicit policy.

```md [server/agents/support/instructions.md]
::source{key="docs"}
Use the docs Source for published product behavior. Say when it does not answer.
::

::capability{key="workspaceShell"}
Inspect the Workspace before answering implementation questions.
::

::skill{path="skills/review-browser-evidence"}
Use this Skill only when the task needs browser evidence.
::
```

ViteHub strips the wrapper directives before model execution and keeps their prose. A file that merely exists in the Workspace does not count as instruction coverage.

## Use the right instruction lifetime

| Surface | Use it for |
| --- | --- |
| Colocated `instructions.md` | Durable repository guidance shared by model and harness-backed execution. |
| Model `driver.instructions` | Model-facing behavior, including invocation-time callbacks and bindings. |
| Harness `driver.instructions` | Invocation-scoped policy passed to the harness constructor. |
| Custom `driver.run` | Application code reads prepared context directly; ViteHub does not build a model prompt for it. |

Read [Agent Drivers](/docs/agents/agent-drivers) for execution-specific behavior and [Workspace context](/docs/agents/workspace-context) for file visibility.
