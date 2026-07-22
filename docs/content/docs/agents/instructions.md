---
title: Instructions
description: Compose model-facing behavior with instruction documents and explicit primitive coverage.
navigation.order: 24
icon: i-lucide-scroll-text
---

An instruction document is Markdown parsed through Comark that ViteHub composes into model-facing instructions. Use it for durable behavior, trust boundaries, source-use policy, capability-use policy, skill-use policy, and uncertainty handling.

Model Driver Instructions are the model-backed Agent Driver field that receives the composed document. ViteHub keeps that model-facing surface separate from harness and custom-run execution.

:::warning
Free-form model-facing guidance lives in Agent Driver Instructions or deterministic imported instruction Markdown. Configured Sources, Capabilities, and Skills stay available as runtime primitives, but ViteHub warns in Agent inspection metadata when they lack explicit instruction coverage.
:::

## Add an instruction document

Place `instructions.md` beside a workspace-backed Agent module when the instructions are long enough to read better as Markdown. ViteHub loads that sibling file before model execution.

```md [server/agents/support/instructions.md]
# Support

You are a support engineer.

Answer from inspected workspace evidence before using outside knowledge.

When sources do not answer the question, say that directly.
```

```ts [server/agents/support/agent.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
  },
  workspace: {
    sources: {},
  },
})
```

Use strings, string arrays, or instruction callbacks when the instruction text is short or generated from trusted runtime data.

```ts [server/agents/support.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'You are a support engineer.',
      'Answer from inspected workspace evidence before using outside knowledge.',
      'When sources do not answer the question, say that directly.',
    ],
  },
})
```

Do not document tool syntax in instructions when a Capability can expose that syntax through tool metadata. Instructions should name policy and behavior, not repeat API reference.

## Import Markdown

Use static `@./path.md` imports to split a large instruction document into local Markdown files.

```md [server/agents/support/instructions.md]
# Support

@./shared-style.md

@./escalation-policy.md
```

Imports are relative to the file that declares them. ViteHub expands imported Markdown recursively, up to four levels, and processes imported Markdown like the parent document. Imports inside code spans and fenced code blocks stay literal.

Instruction imports only read relative files. Remote URLs, absolute paths, and globs fail because an instruction document should not widen runtime reachability.

Use [Markdown Templates](/docs/reference/markdown-templates) when application code needs the reusable deterministic template API outside Agent instruction composition.

## Read invocation context

Instruction composition can read explicit `context.*` paths from trusted Agent Invocation Context Values. Use double braces for scalar values and triple braces for trusted Markdown content.

```md [server/agents/support/instructions.md]
Answer for {{ context.customerName }}.

{{{ context.supportPolicy }}}
```

The value must already exist in invocation context. Missing `context.*` bindings fail during Instruction Composition instead of rendering empty output. Composition does not read arbitrary runtime objects, environment variables, request fields, or JavaScript expressions.

## Read Workspace bindings

Use Workspace bindings when instruction text should read explicit Workspace-owned values. Bind scalar values with `{{ workspace.<name> }}`.

```ts [server/agents/support/agent.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Use {{ workspace.tone }} tone.',
      'Follow this policy:',
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

`@workspace.<name>` inserts a Markdown binding and then runs the same Instruction Composition pass on that inserted Markdown. Use it for explicit instruction fragments that live in the Workspace. ViteHub reads only bindings declared under `workspace.bindings`; it does not scan or auto-load every Markdown file in the Workspace.

Missing `workspace.*` bindings fail during Instruction Composition instead of rendering empty output.

## Branch with conditions

Use `if`, `else-if`, and `else` blocks for conditional instruction sections.

```md [server/agents/support/instructions.md]
::if{context.audience === 'technical'}
Include implementation details and cite file paths.
::else-if{context.audience === 'support'}
Prefer customer-facing language and next actions.
::else
Keep the answer concise.
::
```

Conditions use a small safe expression subset: `context.*` paths, string, number, boolean, and `null` literals, equality checks, `&&`, `||`, `!`, and parentheses. ViteHub rejects function calls, property access outside `context.*`, and other JavaScript.

Use Comark attribute syntax such as `::if{condition="context.audience === 'technical'"}` when authoring new condition blocks. The shorter `::if{context.audience === 'technical'}` form remains supported.

## Cover configured primitives

Explicit instruction coverage means the instruction document names how a configured Source, Capability, or Skill should be used. A merely discoverable Workspace file should not clear coverage warnings; the file must be imported or bound from the Agent Driver instructions.

```md [server/agents/support/instructions.md]
# Support

::source{key="docs"}
Use the docs Source for published product behavior. Say when the docs do not answer.
::

::capability{key="workspaceShell"}
Use Workspace inspection before answering implementation questions.
::

::skill{path="skills/review-browser-evidence"}
Use this Skill only when the task needs browser evidence.
::
```

ViteHub records the coverage metadata and strips the wrapper directives before sending the composed instructions to the model. The authored prose inside each block remains model-facing.

Tool descriptions and schemas are different. They remain structured tool contracts and should stay with the tool definition; they are not arbitrary system-instruction injection and they do not clear broader instruction coverage by themselves.

`{{ capabilities }}` and `{{ capabilities.<id> }}` do not render model-facing prose. They fail during Instruction Composition so missing coverage remains visible.

## Use Capability context

Capabilities can add invocation context values for instruction composition. This is structured runtime data, not hidden prompt text.

```ts [server/agents/support.ts]
import { defineCapability } from '@vite-hub/agent'

const supportAudience = defineCapability({
  id: 'support-audience',
  configure(context) {
    context.context.set('audience', 'technical')
    context.context.set('customerName', 'Acme')
  },
})
```

Coverage warnings clear only when Agent Driver Instructions, or a deterministic imported instruction file, explicitly covers the configured primitive. A Workspace file that merely exists does not clear the warning.

## Harness and run drivers

Harness-backed drivers have two instruction surfaces with different lifetimes. A colocated `instructions.md` is durable repository guidance that ViteHub renders into the Harness Workspace Session as `AGENTS.md` and `CLAUDE.md`. `driver.instructions` is resolved for each invocation and passed to the AI SDK `HarnessAgent` constructor, which fits runtime policy derived from call options or invocation context.

```ts [server/agents/review/agent.ts]
import { defineAgent } from '@vite-hub/agent'
import { codexDriver } from '@vite-hub/agent/harness/codex'

type ReviewOptions = {
  systemInstructions: string
  workDir: string
}

export default defineAgent({
  driver: codexDriver<ReviewOptions>({
    instructions: ({ input }) => input.options?.systemInstructions,
    workDir: ({ input }) => input.options?.workDir,
  }),
})
```

Custom `driver.run` code receives prepared runtime context and decides which values to read. It does not receive a composed model prompt unless your code builds one.

## Next steps

- Read [Agent Drivers](/docs/agents/agent-drivers) for driver-specific instruction behavior.
- Read [Workspace context](/docs/agents/workspace-context) for Source visibility and coverage.
- Read [Capabilities](/docs/capabilities) for ability boundaries and tool contracts.
