---
title: Official capabilities
description: Choose an official Capability by what the Agent needs to do.
navigation.title: Official capabilities
navigation.order: 102
navigation.group: Capabilities
icon: i-lucide-list-checks
---

ViteHub exports its built-in Capabilities from `@vite-hub/agent/capabilities`.
Choose a Capability by what the Agent needs to do. Each linked page shows how to configure it, what the Agent receives, and how to verify it.

```ts [server/agents/support.ts]
import {
  access,
  blob,
  browser,
  chat,
  channelDelivery,
  chatSummary,
  codeHost,
  title,
  db,
  email,
  fetch,
  git,
  gmail,
  inputCommands,
  kv,
  llmGate,
  llmRoute,
  mcp,
  memory,
  openapi,
  otlp,
  papercuts,
  progressSummary,
  rateLimit,
  sandbox,
  schedule,
  skills,
  transcribe,
  usage,
  diagnostics,
  webSearch,
  workspaceShell,
} from 'vite-hub/agent/capabilities'
```

## Catalog

### Invocation

| Ability | Capability | Use it when |
| --- | --- | --- |
| Invocation access | [`access()`](/docs/agents/capabilities/access) | Narrow chat admission or Workspace access from trusted invocation identity. |
| Chat behavior | [`chat()`](/docs/agents/capabilities/chat) | Start Agent Invocations from chat messages and manage Chat History. |
| Input commands | [`inputCommands()`](/docs/agents/capabilities/input-commands) | Transform command-shaped user input before the Agent runs. |

### Workspace

| Ability | Capability | Use it when |
| --- | --- | --- |
| Browser automation | [`browser()`](/docs/browser/agent-capability) | A Provider Agent needs a managed headless browser, browser guidance, and screenshot delivery. |
| Workspace files | [`workspaceShell()`](/docs/workspace/agent-capability) | Inspect or edit Workspace files, or run configured Workspace commands. |
| Git source history | [`git()`](/docs/agents/capabilities/git) | The Agent needs bounded Git source-history inspection or local Workspace Session git state selection. |
| Skills file | [`skills()`](/docs/agents/capabilities/skills) | The Agent requires a Workspace skill file at invocation time. |
| Durable memory | [`memory()`](/docs/agents/capabilities/memory) | The Agent needs scoped durable records across invocations. |

### Runtime primitives

| Ability | Capability | Use it when |
| --- | --- | --- |
| KV storage | [`kv()`](/docs/kv/agent-capability) | The Agent needs scoped key-value read or edit tools. |
| Blob storage | [`blob()`](/docs/blob/agent-capability) | The Agent needs scoped object read or edit tools. |
| Database | [`db()`](/docs/database/agent-capability) | The Agent needs guarded SQL query, schema, or mutation tools. |
| Email | [`email()`](/docs/email/agent-capability) | Send authorized plain-text messages through the configured Email primitive. |
| Channel delivery | [`channelDelivery()`](/docs/channels/agent-capability) | Send the Agent result through a Channel to a recipient that the application selects. |
| Sandbox execution | [`sandbox()`](/docs/sandbox/agent-capability) | The Agent may run an allowlisted executable in an isolated runtime. |
| Schedules | [`schedule()`](/docs/schedule/agent-capability) | The Agent declares scheduled invocations or manages Runtime Schedules through tools. |
| OTLP telemetry | [`otlp()`](/docs/agents/capabilities/otlp) | Live Agent Invocation events and completed traces should be exported to an OpenTelemetry receiver. |
| Papercut reporting | [`papercuts()`](/docs/agents/capabilities/papercuts) | Let an Agent report small failures and wasted work to an application-owned sink. |
| Operational diagnostics | [`diagnostics()`](/docs/agents/capabilities/diagnostics) | Invocation outcomes and scoped runtime resource observations should go to an application-owned reporter. |

### External context

| Ability | Capability | Use it when |
| --- | --- | --- |
| MCP servers | [`mcp()`](/docs/agents/capabilities/mcp) | Add tools from external MCP servers, such as an Executor catalog, to the Agent. |
| Web search | [`webSearch()`](/docs/agents/capabilities/web-search) | The Agent needs model web search or normalized web search/read tools. |
| Fetch tools | [`fetch()`](/docs/agents/capabilities/fetch) | The Agent needs named HTTP tools for developer-approved endpoints. |
| OpenAPI tools | [`openapi()`](/docs/agents/capabilities/openapi) | The Agent needs a selected OpenAPI operation catalog exposed as bounded HTTP tools or a generated Capability CLI. |
| Transcription | [`transcribe()`](/docs/agents/capabilities/transcribe) | Turn audio input into text before model execution. |
| Code Host | [`codeHost()`](/docs/agents/capabilities/code-host) | Read and change repositories on GitHub, GitLab and Forgejo. |
| Gmail | [`gmail()`](/docs/agents/capabilities/gmail) | Search and read Gmail or create unsent drafts through a Google Connection. |

### Decisions and output

| Ability | Capability | Use it when |
| --- | --- | --- |
| LLM routing | [`llmRoute()`](/docs/agents/capabilities/llm-route) | Choose one developer-defined route with a model before the invocation. |
| LLM gate | [`llmGate()`](/docs/agents/capabilities/llm-gate) | Allow or reject a request with a model before the invocation. |
| Rate limit | [`rateLimit()`](/docs/rate-limit/agent-capability) | Consume a trusted invocation budget before the Agent runs. |
| Title | [`title()`](/docs/agents/capabilities/title) | Generate a title for Agent output, finish extensions, or Channel threads. |
| Chat summary | [`chatSummary()`](/docs/agents/capabilities/chat-summary) | Replace a summary command with a conversation summary. |
| Progress summary | [`progressSummary()`](/docs/agents/capabilities/progress-summary) | Summarize current reasoning and tool activity while an Agent streams. |
| Usage | [`usage()`](/docs/agents/capabilities/usage) | Request provider usage metadata and expose normalized tokens and cost. |

## Next steps

- [Custom capabilities](/docs/agents/capabilities/custom)
- [Capabilities API](/docs/agents/capabilities)
- [Agent definitions](/docs/agents/agent-definitions)
