---
title: Instructions
description: Tell an Agent's model how to behave, in a Markdown file next to the Agent, shared files, or trusted values.
navigation.order: 20
navigation.group: Instructions and tools
icon: i-lucide-scroll-text
navigation.kind: Guides
---

Instructions tell a model or coding provider how to behave: which evidence to
trust, when to escalate, and what to say when evidence is missing.
Model-backed and provider-backed Drivers read them. Custom `run` and `ask`
Drivers do not.

Tool schemas go in Capabilities and files go in the
[Workspace](/docs/agents/workspace-context). Instructions say how to use them.

## Start with a colocated document

Put longer guidance in `instructions.md` next to the Agent:

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

ViteHub uses this file when `driver.instructions` is not set, and parses it as
Markdown with Comark. How each Driver gets it:

- Codex gets it as developer instructions. Codex puts them before the working
  directory in its prompt, so it can reuse the cached prompt prefix. ViteHub
  writes `AGENTS.md` instead when the instructions are over 32 KiB, when
  `driver.env` sets `T3CODE_CODEX_LAUNCH_ARGS`, or when the launch arguments
  set `developer_instructions`. Driver instructions replace
  `developer_instructions` in the Codex configuration file.
- A resumed Codex session continues only while its instructions stay the same.
  Otherwise ViteHub starts a new session and sends it the conversation.
- Claude Code gets it as a prompt file.
- [Sandboxes](/docs/agents/sandboxes) get it in the Sandbox Home. With a
  Workspace, a provider Driver still gets it as Driver instructions, not as
  `AGENTS.md` in the Workspace.
- A model Driver with a Workspace reads it from `AGENTS.md` in the Workspace.

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

It takes a string, an array of strings, or a callback that returns them per
Invocation.

## Split reusable guidance

Import Markdown files with `?raw` and combine them in `driver.instructions`:

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

ViteHub does not follow file references. `@./path.md` stays plain text.

## Extend inherited instructions

A parent Agent can keep one slot for each child's instructions. Put exactly
one `{{{ instructions }}}` marker in `template`, outside code:

```ts [server/agents/reviewer/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: codexDriver({
    instructions: {
      template: 'Inspect the request.\n\n{{{ instructions }}}\n\nExplain the result.',
      content: 'Use concise language.',
    },
  }),
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

The child text replaces the slot content, and does not append. A child with
no instructions keeps the parent `content`. A colocated `instructions.md` fills
the slot when the template has no `content`.

To drop the inherited template, set
`instructions: { mode: 'replace', value: '...' }` or a new
`{ template, content }` object. Without a template, child instructions replace
the parent document.

To add to the parent document, or to change part of it, set
`instructions: { extend }`. The function gets the parent's instructions as one
string and returns the child's complete document:

```ts [server/agents/bot-dev/agent.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import bot from '../bot/agent'
import development from './development.md?raw'

export default defineAgent({
  extends: bot,
  driver: {
    instructions: { extend: inherited => `${inherited}\n\n${development}` },
  },
})
```

- Without a parent, `inherited` is an empty string.
- When the parent uses a callback or a template, the function runs for each
  Invocation and gets the resolved document, with the template slot filled.
- `{{{ context.customInstructions }}}` slots and `data.context.*` bindings in
  the returned document render as usual.
- A plain function is not an extension. It stays a callback that gets the
  Invocation context.
- A colocated `instructions.md` cannot extend the parent's document.

Read [Extend an Agent](/docs/agents/agent-presets#extend-an-agent) for other
rules.

## Insert trusted invocation values

Read Invocation values with `data.context.*` bindings. Use `:insert` for
trusted Markdown:

```md [server/agents/support/instructions.md]
Answer for {{ data.context.customerName }}.

:insert{:markdown="data.context.supportPolicy"}
```

The caller or a Capability must set these values first. A missing binding
fails the Invocation, and is not rendered as empty text. Templates cannot read
request fields, environment variables, or JavaScript expressions.

### Reserve a custom instruction slot

To let a host add trusted Markdown per invocation, write the exact
`{{{ context.customInstructions }}}` slot in the document:

```md [server/agents/support/instructions.md]
Answer from the support policy.

{{{ context.customInstructions }}}
```

The slot is optional when no custom instructions are given. A given value must
be a string, and the document must have at least one slot outside a fenced,
inline, or HTML code example. The Markdown is added after template rendering,
so its bindings and directives stay plain text. Generic
`data.context.customInstructions` scalar and `:insert` bindings do not work.
The written slot makes the trust boundary explicit.

Use conditions for small policy branches:

```md [server/agents/support/instructions.md]
::if{:value="data.context.audience" eq="technical"}
Include implementation details and cite file paths.
::else
Prefer customer-facing language and next actions.
::
::
```

Conditions bind `data.context.*` paths and support `eq`, `neq`, `gt`, `gte`,
`lt`, and `lte`. For a compound condition, compute a boolean in TypeScript. See
[Markdown templates](/docs/reference/markdown-templates) for the full syntax.

## Insert Workspace bindings

Declare values or Markdown files in `workspace.bindings`, then use them by
name:

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

`:insert` adds the Markdown as it is, without evaluating its bindings,
conditions, or coverage directives. Render dynamic content before you pass it.
ViteHub does not scan or load other Markdown files in the Workspace.

## Cover configured primitives

Say how to use each Source, Capability, and Skill you configure. ViteHub
records this coverage for inspection, and warns when one has no policy.

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

A custom Capability the model never uses, such as accounting or telemetry, can
turn off the warning with `instructionCoverage: false`. It then adds no empty
text to the prompt.

## Choose where instructions live

| Instruction source | Use it for |
| --- | --- |
| Colocated `instructions.md` | Lasting guidance for model-backed and provider-backed Drivers. |
| Model `driver.instructions` | Model behavior, with callbacks and bindings that run per Invocation. |
| Provider `driver.instructions` | Per-Invocation policy that ViteHub writes into the provider working directory. |
| Custom `driver.run` | Your code reads the prepared context. ViteHub builds no model prompt. |

Read [Agent Drivers](/docs/agents/agent-drivers) for each Driver. Run
`vitehub agent info --agent <name>` to see the resolved instructions and
coverage warnings. See the [CLI development loop](/docs/development/cli).

## Next steps

[Attach Capabilities](/docs/agents/capabilities) for tools. Then pick [Chat History](/docs/agents/chat-history-sessions) or [Workspace context](/docs/agents/workspace-context) for the evidence the Driver needs.
