---
title: Capabilities
description: Give an Agent the tools and behavior it needs, without full access to your server.
navigation.title: Capabilities
navigation.order: 21
navigation.group: Instructions and tools
icon: i-lucide-blocks
navigation.kind: Concepts
---

A Capability gives an Agent one named ability, such as web search, through `defineAgent({ capabilities })`. It can add tools, triggers, input processing, output metadata, and checks that run before an Invocation (one Agent run).

App code calls Server Primitives with full trust. A Capability picks which operations the Agent can use. Write the behavior in [Instructions](/docs/agents/instructions) first, then attach the tools it needs.

## Choose a Capability by task

| Task | Start with |
| --- | --- |
| Read project files | [Workspace tools](/docs/workspace/agent-capability) and [Skills](/docs/agents/capabilities/skills) |
| Query application data | [Database](/docs/database/agent-capability), [KV](/docs/kv/agent-capability), or [Blob](/docs/blob/agent-capability) |
| Search or call an external service | [Web search](/docs/agents/capabilities/web-search), [Fetch](/docs/agents/capabilities/fetch), [OpenAPI](/docs/agents/capabilities/openapi), or [MCP](/docs/agents/capabilities/mcp) |
| Work the person's open page | [Page](/docs/agents/capabilities/page) |
| Continue a conversation | [Chat](/docs/agents/capabilities/chat), [Chat History](/docs/agents/chat-history-sessions), and [Memory](/docs/agents/capabilities/memory) |
| Restrict work | [Access](/docs/agents/capabilities/access), [Budget](/docs/agents/capabilities/budget), and [Rate Limit](/docs/rate-limit/agent-capability) |
| Inspect cost and results | [Usage](/docs/agents/capabilities/usage), [Diagnostics](/docs/agents/capabilities/diagnostics), and [OTLP](/docs/agents/capabilities/otlp) |

The [official catalog](/docs/agents/capabilities/official) lists more. Write a [custom Capability](/docs/agents/capabilities/custom) for your own tools.

## Choose the API by its caller

Installing a Server Primitive does not give the Agent access. Attach a Capability for that.

| | Server Primitive | Capability |
| --- | --- | --- |
| Caller | Application server code | An Agent during an Invocation |
| Access | A documented server import | Selected tools, policy, requirements, or context |
| Selection | Application code calls it | The Agent Definition or invocation selects it |
| Model access | None | Only the operations the Capability contributes |

A Capability never gives the full Runtime Context or host access. Its tools, requirements, policy, and metadata set what the Agent can use. App code still calls the primitives through their server APIs.

## Attach a Capability

Import factories from `vite-hub/agent/capabilities`, or `@vite-hub/agent/capabilities` in a standalone package.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'
import { file } from 'vite-hub/workspace'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: { sources: { policy: file('support.md') } },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

Create `support.md` in the project root first.

Tool policy defaults to `allow`. Set `policy: 'require-approval'` or `'deny'` when a tool needs another runtime check. Modes, scopes, allowlists, requirements, and input validation still apply before policy.

To pick Capabilities per run, pass a callback. ViteHub calls it once, after it resolves the Agent Invoker (who started the run) and before Capability setup. Capabilities from the active Channel still apply.

```ts [server/agents/support.ts] fragment
export default defineAgent({
  driver: { model },
  capabilities: ({ invoker }) => [
    workspaceShell({ mode: 'read' }),
    ...(invoker.meta?.support === true ? [internalDiagnostics] : []),
  ],
})
```

Keep Capabilities that add Agent Triggers, chat admission, or static Workspace Sources in a static list. ViteHub registers those before a run exists.

## What Capabilities can contribute

| Contribution | What it changes |
| --- | --- |
| Requirements | Primitive, Workspace mode, path, or policy checks that must pass first. |
| Tools | Model operations, for compatible Drivers only. |
| Provider tools | Provider-native tool requests, such as model web search mode. |
| Agent Triggers | Events that start runs through the trigger API. |
| Input behavior | Input transforms, transcription, decisions, gates, and rate limits before the run. |
| Output behavior | Stream renderers, finish extensions, usage records, titles, and summaries. |
| Metadata | Configuration for diagnostics and CLI inspection. |

Agent inspection shows metadata under each Capability id. ViteHub keeps JSON values, sorts keys and ids, drops unsupported or cyclic values, and redacts keys that look like auth, API keys, credentials, passwords, secrets, or tokens.

> [!WARNING]
> Metadata must describe configuration or a check result. Never put Env values, authentication material, or credentials in it.

For data read after a run by evals, finish hooks, or Channel delivery, use `defineCapability({ finish })`. Agent Evals read it with `observation.extensions.get(capabilityId)` and the `hasCapabilityExtension(capabilityId)` scorer.

## Finish without the Driver

A Capability `input` phase can finish an Invocation only with a `Response`. When app code decides the result for some inputs, such as mail rules that label an email before a model runs, use `defineAgent({ data, intercept })` instead. `intercept` returns a typed value that becomes the Invocation output, and `runAgent()` types `result.output` as the union of that value and the Driver output.

```ts [server/agents/labeller.ts] fragment
export default defineAgent({
  data: email,
  intercept: ({ data }) => data.from.endsWith('@github.com') ? { source: 'rule' as const, label: 'GitHub' } : undefined,
  driver: { model, output: { schema: modelLabel } },
})
```

Read [Finish before the Driver](/docs/agents/agent-definitions#finish-before-the-driver) for hooks, traces, and layer rules.

## Driver support

- **Model-backed** Drivers use model tools and Provider Tools (tools the provider runs, such as model web search).
- **Provider-backed** Drivers get Agent tools through a private MCP bridge and scoped Workspace behavior. They do not support model-specific Provider Tools such as `webSearch({ mode: 'model' })`.
- **Custom-run** Drivers get prepared input and run context. `driver.run` decides which Capability outputs to read.

Put guidance on when to use a Capability in the Driver Instructions or deterministic imported instruction Markdown. Tool descriptions and schemas stay part of the model's tool contract.

## Capability lifecycle

ViteHub applies Capabilities in list order. It checks duplicate ids and runtime requirements, applies trigger contributions, then runs configure, prepare, bind, input, resolve, and output for each run.

Only `access()` has a fixed position: first, so later Capabilities get the restricted Workspace and tools.

## Next steps

- [Official capabilities](/docs/agents/capabilities/official)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Instructions](/docs/agents/instructions)
- [Chat History and sessions](/docs/agents/chat-history-sessions)
- [Workspace context](/docs/agents/workspace-context)
