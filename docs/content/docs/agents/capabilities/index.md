---
title: Capabilities
description: Give an Agent tools and behavior without handing it unrestricted server access.
navigation.title: Overview
navigation.order: 101
navigation.group: Capabilities
icon: i-lucide-blocks
---

Capabilities give an Agent a named ability through `defineAgent({ capabilities })`.
They can add tools, triggers, input processing, output metadata, and checks that run before an invocation.

A Capability is not a server primitive.
Server primitives give trusted app code authority.
Capabilities decide which operations an Agent Invocation can use.

## Choose the API by its caller

Installing a Server Primitive does not give an Agent access to it. Attach a Capability when the Agent needs that operation.

| | Server Primitive | Capability |
| --- | --- | --- |
| Caller | Application server code | An Agent during an Invocation |
| Access | A documented server import | Selected tools, policy, requirements, or context |
| Selection | Application code calls it | The Agent Definition or invocation selects it |
| Model access | None | Only the operations the Capability contributes |

A Capability does not expose the full Runtime Context or unrestricted host access. Its tools, requirements, policy, and metadata define what the Agent can inspect and use. Application code can still call the same Server Primitives through their server APIs.

## Capability lifecycle

ViteHub applies Capabilities in the order listed or returned by the Agent Definition.
It validates duplicate ids, checks runtime requirements, applies Capability Trigger Contributions, and then runs configure, prepare, bind, input, resolve, and output phases for each invocation.

`access()` is the only official Capability with a fixed position rule.
Place it first so later Capabilities receive the restricted Workspace and tool access.

## Attach a Capability

Import official factories from `@vite-hub/agent/capabilities`.
Import the factory from the Capabilities entry point:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

Attaching a Capability opts the Agent into that ability. Model-facing tool policy defaults to `allow`. Set `policy: 'require-approval'` or `policy: 'deny'` when a tool needs another runtime check. Modes, scopes, allowlists, requirements, and input validation still restrict the operation before policy runs.

Use a callback when invocation context decides the Agent Definition's Capability list. ViteHub calls it once after resolving the Agent Invoker and before Capability setup; Capabilities contributed by the active Channel still compose normally.

```ts [server/agents/support.ts]
export default defineAgent({
  driver: { model },
  capabilities: ({ actor }) => [
    workspaceShell({ mode: 'read' }),
    ...(actor.meta?.support === true ? [internalDiagnostics] : []),
  ],
})
```

Return only invocation-scoped behavior from the callback. Capabilities that contribute Agent Triggers, chat admission, or static Workspace Sources must stay in a static list because ViteHub registers those contributions before an invocation exists.

## Use an Eve extension

ViteHub detects compatible Eve extension packages in a static Capability list and compiles their tools into a Capability. Install the extension and its Eve peer, then use the extension's mount factory:

```bash
pnpm add @github-tools/eve-extension@0.8.0 eve@0.72.1
```

```ts [server/agents/reviewer.ts]
import github from '@github-tools/eve-extension'
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model },
  capabilities: [
    github({ preset: 'code-review' }),
  ],
})
```

`repositoryHost()` and `repositoryHostContext()` are no longer built in. Replace their GitHub tools with the extension above. GitHub Channel invocations still expose trusted pull request context through `pullRequest.read(invocation)` from `vite-hub/agent/channels`; use [`codeHost()`](/docs/agents/capabilities/code-host) for host-neutral repository tools.

The Vite plugin reads the package's Eve manifest and fails the build when a declared contract version is unsupported. For format 2, the bridge accepts `config@1`, `extension@1`, `tool@20` or `tool@54`, and `dynamicTool@20` or `dynamicTool@52`. GitHub Tools 0.7.0 uses the older pair; 0.8.0 uses the newer pair. The optional Eve peer also accepts 0.46.1 for GitHub Tools 0.7.0. Native Eve 0.72 `tool@76` and `dynamicTool@72` contracts remain unsupported. The manifest check does not validate the installed Eve version. Use the tested Eve 0.72.1 and GitHub Tools 0.8.0 pair above.

The bridge accepts one mount per Eve package in a Vite app. The mount must be a direct default import called with at most one config argument inside a top-level static Capability list. ViteHub then loads the package's generated `/tools` entry point. Calls from a dynamic Capability callback, nested runtime code, or a separate runtime import are unsupported. The Vite plugin rejects detected direct mounts in these forms, but mounts hidden in helpers or other modules can escape build validation. Eve's `defineExtension` API belongs to the extension package. ViteHub does not call it as a separate mount API; it consumes the package's callable default export and validates the generated manifest. The `0.8.0` package uses this API and declares the contract versions listed above.

Static tools and one dynamic handler are supported for the accepted manifest contracts. The handler may use `session.started`, `turn.started`, or `step.started`, but it must not require an authoritative session sequence or step index, an effective model or `modelId`, or a real per-step hook. Multiple active handlers on one dynamic tool are rejected. ViteHub resolves the selected handler once while preparing each Agent Invocation, so `step.started` does not run before every model step. The handler can read the following event data:

| Event | Data |
| --- | --- |
| `session.started` | `{}` |
| `turn.started` | `turnId` |
| `step.started` | `turnId` |

The session ID uses `run.threadId` and falls back to `run.runId` or the invoker ID. The turn ID uses `run.runId` and falls back to the session ID. Reading `session.turn.sequence` or an event's `data.sequence` throws `AGENT_R0415` because ViteHub has no authoritative persisted Eve turn counter. Reading a step event's `data.stepIndex` or `data.modelId`, or a step resolver context's `model`, throws the same diagnostic. Other preparation resolver contexts expose `model: null`. Legacy resolvers that ignore these unavailable fields continue to work. ViteHub does not persist an Eve session object across process restarts.

The bridge preserves tool input and output schemas, `toModelOutput` including content and file parts, and Eve's `always`, `never`, and `once` approval modes. `endsTurn`, labels, `approvalKey`, and `availableInSubagents` have no ViteHub execution semantics and do not appear in current CLI inspection. Approval definitions may provide a `{ request }` callback. A `response` authorizer is rejected because ViteHub has no responder-auth context. The built-in HTTP Chat route stores pending approvals in its configured Chat state, reconstructs the authoritative tool call on the server, and consumes each response once under a session lock. Client-supplied chat history never creates approval authority. Eve `once` approvals come only from Chat state for the current invoker and chat session. Invocation context values, including values set by `admission.context` or `mapInput`, cannot approve a tool.

This bridge is not yet a complete Eve runtime. Tool and approval contexts do not support `getSandbox()`, `getToken()`, or `requireAuth()`; using one throws at runtime. Accepted older contracts retain a `getSkill()` diagnostic stub; Eve removed that accessor in version 0.66. ViteHub does not mount Eve dynamic skill contributions. Session authentication fields remain `null`. Eve auth providers and sandbox access are not connected to ViteHub Connections or the Sandbox primitive. Use ViteHub Workspace Skills where the Agent Driver supports them.

## What Capabilities can contribute

| Contribution | What it changes |
| --- | --- |
| Requirements | Primitive, Workspace mode, Workspace path, or policy checks that must pass before the Capability applies. |
| Tools | Model-facing operations exposed only to compatible Agent Drivers. |
| Provider tools | Provider-native tool requests, such as model web search mode. |
| Agent Triggers | Product events that start Agent Invocations through the Agent Package trigger API. |
| Input behavior | Pre-invocation input transforms, transcription, decisions, gates, and rate limits. |
| Output behavior | Stream renderers, finish extensions, usage records, titles, and summaries. |
| Metadata | Inspectable configuration for runtime diagnostics and CLI inspection. |

Capability metadata appears under the Capability id in Agent inspection output. ViteHub keeps JSON values, sorts object keys and Capability ids, drops unsupported or cyclic values, and redacts keys shaped like auth, API keys, credentials, passwords, secrets, or tokens. Metadata must describe configuration or an explicit check result; it must not include Env values, authentication material, or credentials.

Use `defineCapability({ finish })` for metadata read by evals, finish hooks, or channel delivery code after an invocation.
Agent Evals expose those values through `observation.extensions.get(capabilityId)` and the `hasCapabilityExtension(capabilityId)` scorer.

## Finish without the Driver

A Capability `input` phase can finish an Invocation only with a `Response`. When app code decides the result for some inputs, such as mail rules that label an email before a model runs, use `defineAgent({ data, intercept })` instead. `intercept` returns a typed value that becomes the Invocation output, and `runAgent()` types its output as the union of that value and the Driver output.

```ts [server/agents/labeller.ts]
export default defineAgent({
  data: email,
  intercept: ({ data }) => data.from.endsWith('@github.com') ? { source: 'rule' as const, label: 'GitHub' } : undefined,
  driver: { model, output: { schema: modelLabel } },
})
```

Read [Finish before the Driver](/docs/agents/agent-definitions#finish-before-the-driver) for hooks, traces, and layer rules.

## Driver support

A model-backed Agent Driver can consume model-facing tools and Provider Tool contributions.
A provider-backed Agent Driver receives Agent tools through the private MCP bridge and scoped Workspace behavior. Provider-backed Drivers do not support model-specific Capability Provider Tool contributions such as `webSearch({ mode: 'model' })`.
A custom-run-backed Agent Driver receives prepared input and invocation context; the `driver.run` implementation decides which Capability outputs to read.

Free-form guidance about when and why to use a Capability belongs in Agent Driver Instructions or deterministic imported instruction Markdown. Tool descriptions and schemas remain part of the model-facing tool contract.

## Next steps

- [Official capabilities](/docs/agents/capabilities/official)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Agent definitions](/docs/agents/agent-definitions)
