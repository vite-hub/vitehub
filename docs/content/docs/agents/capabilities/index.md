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
  capabilities: ({ actor }) => [
    workspaceShell({ mode: 'read' }),
    ...(actor.meta?.support === true ? [internalDiagnostics] : []),
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

When app code can answer without the model (the Driver), such as a mail rule that labels an email, skip it. A Capability `input` phase can only end a run with a `Response`. For a typed value, use `defineAgent({ data, intercept })`: its return value becomes the output, and `runAgent()` types the output as that value or the Driver output.

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

## Use an Eve extension

ViteHub compiles a compatible Eve extension (a tool package for the Eve agent framework) in a static Capability list into a Capability. Install it with its Eve peer and call its mount factory:

```bash
pnpm add @github-tools/eve-extension@0.8.1 eve@0.80.1
```

```ts [server/agents/reviewer.ts] fragment
import github from '@github-tools/eve-extension'
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model },
  capabilities: [
    github({ preset: 'code-review' }),
  ],
})
```

`repositoryHost()` and `repositoryHostContext()` are gone; use this extension for their GitHub tools. GitHub Channel runs still get trusted pull request context from `pullRequest.read(invocation)` in `vite-hub/agent/channels`. For repository tools on GitHub, GitLab, and Forgejo, use [`forge()`](/docs/agents/capabilities/forge).

### Supported versions

The Vite plugin reads the Eve manifest and fails the build on an unsupported contract version. For format 2, the bridge accepts `config@1`, `extension@1`, `tool@20`/`dynamicTool@20` (GitHub Tools 0.7.0), `tool@54`/`dynamicTool@52` (0.8.0), and `tool@76`/`dynamicTool@72` (0.8.1, built with Eve 0.72.1).

Newer contracts, such as Eve 0.80's `tool@92` and `dynamicTool@86`, are rejected until tested. The check does not validate the installed Eve version. Use the tested pair: Eve 0.80.1 (the optional peer) and GitHub Tools 0.8.1.

### Mount rules

One mount per Eve package per Vite app: a direct default import, called with at most one config argument, inside a top-level static Capability list. ViteHub then loads the package's generated `/tools` entry. Calls from a dynamic callback, nested runtime code, or a separate runtime import are unsupported, and the plugin rejects the direct forms it detects.

> [!WARNING]
> A mount hidden in a helper or another module can escape the build check.

Eve's `defineExtension` belongs to the extension package. ViteHub does not call it; it uses the callable default export and checks the manifest. The `0.8.1` package uses this API and declares the versions above.

### Dynamic handlers

ViteHub supports static tools and one dynamic handler on `session.started`, `turn.started`, or `step.started`. The handler must not need an authoritative session sequence or step index, the effective model or `modelId`, or a real per-step hook. A dynamic tool with several active handlers is rejected. The handler resolves once per run, so `step.started` does not run before every model step. It can read:

| Event | Data |
| --- | --- |
| `session.started` | `{}` |
| `turn.started` | `turnId` |
| `step.started` | `turnId` |

The session ID is `run.threadId`, else `run.runId` or the invoker ID. The turn ID is `run.runId`, else the session ID.

ViteHub saves no authoritative Eve turn counter, so `session.turn.sequence`, `data.sequence`, a step event's `data.stepIndex` or `data.modelId`, and a step resolver context's `model` throw `AGENT_R0415`. Other preparation resolver contexts give `model: null`. Older resolvers that ignore these fields still work. Eve session objects do not survive process restarts.

### Tools and approvals

The bridge keeps tool input and output schemas, `toModelOutput` with content and file parts, and Eve's `always`, `never`, and `once` approval modes. `endsTurn`, labels, `approvalKey`, and `availableInSubagents` do nothing and are not in CLI inspection.

Approvals can have a `{ request }` callback. A `response` authorizer is rejected: ViteHub has no responder-auth context. The built-in HTTP Chat route stores pending approvals in Chat state, rebuilds the authoritative tool call on the server, and uses each response once under a session lock.

> [!WARNING]
> Client chat history never approves a tool. Eve `once` approvals come only from Chat state for the current invoker and chat session. Context values, including those from `admission.context` or `mapInput`, cannot approve.

### What the bridge does not support

- Tool and approval contexts throw on `getSandbox()`, `getToken()`, and `requireAuth()`.
- Older contracts keep a `getSkill()` diagnostic stub. Eve removed it in 0.66.
- Eve dynamic skill contributions are not mounted. Use ViteHub Workspace Skills where the Driver supports them.
- Session auth fields stay `null`. Eve auth providers and sandbox access are not connected to ViteHub Connections or the Sandbox primitive.

## Next steps

- [Official capabilities](/docs/agents/capabilities/official)
- [Custom capabilities](/docs/agents/capabilities/custom)
- [Instructions](/docs/agents/instructions)
- [Chat History and sessions](/docs/agents/chat-history-sessions)
- [Workspace context](/docs/agents/workspace-context)
