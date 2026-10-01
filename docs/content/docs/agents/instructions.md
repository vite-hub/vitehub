---
title: Instructions
description: Write durable model-facing behavior and policy for an Agent.
navigation.order: 31
navigation.group: Configure
icon: i-lucide-scroll-text
---

Instructions tell a model or a coding provider how to behave. Use them for
durable behavior: which evidence to trust, when to escalate, and what to say
when evidence is missing. Model-backed and provider-backed Drivers read
instructions. Custom `run` and `ask` Drivers do not.

Keep tool schemas in Capabilities and files in the
[Workspace](/docs/agents/workspace-context). Instructions describe how to use
them.

## Start with a colocated document

Put longer guidance beside the Agent as `instructions.md`:

```md [server/agents/support/instructions.md]
# Support

Answer from inspected Workspace evidence before using outside knowledge.

When the docs do not answer the question, say that directly.
```

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
  },
})
```

The colocated document is the default when `driver.instructions` is absent.
ViteHub parses it as Markdown through Comark. Provider Drivers receive the
rendered document as `AGENTS.md` for Codex, or as a prompt file for Claude
Code.

Use `driver.instructions` for short text:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

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

`driver.instructions` accepts a string, an array of strings, or a callback
that returns them for each Invocation.

## Split reusable guidance

Import authored Markdown with `?raw` and combine the parts in
`driver.instructions`:

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import sharedStyle from './shared-style.md?raw'
import escalationPolicy from './escalation-policy.md?raw'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [sharedStyle, escalationPolicy],
  },
})
```

ViteHub does not follow file references. Text such as `@./path.md` stays
literal in the document.

## Extend inherited instructions

A parent Agent can reserve one slot for the instructions of each child. Put
exactly one `{{{ instructions }}}` marker in `template`, outside code:

```ts [server/agents/reviewer/agent.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    kind: 'codex',
    instructions: {
      template: 'Inspect the request.\n\n{{{ instructions }}}\n\nExplain the result.',
      content: 'Use concise language.',
    },
  },
})
```

```ts [server/agents/migration-reviewer/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import reviewer from '../reviewer/agent'

export default defineAgent({
  extends: reviewer,
  driver: { instructions: 'Check migration safety.' },
})
```

The child text replaces the slot content. It does not append to it. A child
that sets no instructions keeps the parent `content`. A colocated
`instructions.md` fills the slot when the template has no `content`.

To discard the inherited template, set
`instructions: { mode: 'replace', value: '...' }`. A new
`{ template, content }` object also replaces it. Without a template, child
instructions replace the parent document. Read
[Extend an Agent](/docs/agents/agent-definitions#extend-an-agent) for the other
inheritance rules.

## Insert trusted invocation values

Read Invocation values through `data.context.*` bindings. Use `:insert` for
trusted Markdown:

```md [server/agents/support/instructions.md]
Answer for {{ data.context.customerName }}.

:insert{:markdown="data.context.supportPolicy"}
```

The caller or a Capability must set these values before composition. A missing
binding fails the Invocation. ViteHub does not render it as empty text.
Templates cannot read request fields, environment variables, or JavaScript
expressions.

Use conditions for small policy branches:

```md [server/agents/support/instructions.md]
::if{:value="data.context.audience" eq="technical"}
Include implementation details and cite file paths.
::else
Prefer customer-facing language and next actions.
::
::
```

Conditions bind `data.context.*` paths and support the `eq`, `neq`, `gt`,
`gte`, `lt`, and `lte` props. Compute a compound condition in TypeScript and
pass a boolean. See [Markdown templates](/docs/reference/markdown-templates)
for the full syntax.

## Insert Workspace bindings

Declare values or Markdown files under `workspace.bindings`. Then reference
only those named bindings:

```ts [server/agents/support/agent.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: [
      'Use {{ data.workspace.tone }} tone.',
      ':insert{:markdown="data.workspace.policy"}',
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

`:insert` adds the declared Markdown as it is. ViteHub does not evaluate
bindings, conditions, or coverage directives inside it. Render dynamic content
before you pass it as a fragment. ViteHub does not scan or load other Markdown
files in the Workspace.

## Cover configured primitives

Say how to use each configured Source, Capability, and Skill. ViteHub records
this coverage for inspection. It warns when a configured primitive has no
explicit policy.

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

ViteHub removes the wrapper directives before the model runs and keeps their
text. A file in the Workspace does not count as coverage.

A custom Capability with no model-facing behavior can turn off this warning
with `instructionCoverage: false`. Use this for accounting and telemetry
Capabilities, so they do not add empty text to the prompt.

## Choose where instructions live

| Instruction source | Use it for |
| --- | --- |
| Colocated `instructions.md` | Durable guidance for model-backed and provider-backed execution. |
| Model `driver.instructions` | Model-facing behavior, including callbacks and bindings that run for each Invocation. |
| Provider `driver.instructions` | Invocation-scoped policy that ViteHub writes into the provider working directory. |
| Custom `driver.run` | Application code reads the prepared context directly. ViteHub does not build a model prompt. |

Read [Agent Drivers](/docs/agents/agent-drivers) for Driver-specific behavior.
Run `vitehub agent info --agent <name>` to see the resolved instructions and
coverage warnings. See the [CLI development loop](/docs/development/cli).
