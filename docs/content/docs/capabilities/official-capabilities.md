---
title: Official capabilities
description: Choose an official Capability by what the Agent needs to do.
navigation.title: Official capabilities
navigation.order: 2
navigation.group: Start here
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
  chatSummary,
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
  papercuts,
  progressSummary,
  rateLimit,
  repositoryHost,
  repositoryHostContext,
  sandbox,
  schedule,
  skills,
  subagents,
  transcribe,
  usage,
  cost,
  webSearch,
  workspaceShell,
} from 'vite-hub/agent/capabilities'
```

## Catalog

### Invocation

| Ability | Capability | Use it when |
| --- | --- | --- |
| Invocation access | [`access()`](/docs/capabilities/access) | Narrow chat admission or Workspace access from trusted invocation identity. |
| Chat behavior | [`chat()`](/docs/capabilities/chat) | Start Agent Invocations from chat messages and manage Chat History. |
| Input commands | [`inputCommands()`](/docs/capabilities/input-commands) | Transform command-shaped user input before the Agent runs. |
| Subagents | [`subagents()`](/docs/capabilities/subagents) | Delegate bounded work to named Agent Definitions through tools. |

### Workspace

| Ability | Capability | Use it when |
| --- | --- | --- |
| Browser automation | [`browser()`](/docs/capabilities/browser) | A Provider Agent needs headless browser guidance and the `agent-browser` CLI is installed. |
| Workspace files | [`workspaceShell()`](/docs/capabilities/workspace-shell) | Inspect or edit Workspace files, or run configured Workspace commands. |
| Git source history | [`git()`](/docs/capabilities/git) | The Agent needs bounded Git source-history inspection or local Workspace Session git state selection. |
| Skills file | [`skills()`](/docs/capabilities/skills) | The Agent requires a Workspace skill file at invocation time. |
| Durable memory | [`memory()`](/docs/capabilities/memory) | The Agent needs scoped durable records across invocations. |

### Runtime primitives

| Ability | Capability | Use it when |
| --- | --- | --- |
| KV storage | [`kv()`](/docs/capabilities/kv) | The Agent needs scoped key-value read or edit tools. |
| Blob storage | [`blob()`](/docs/capabilities/blob) | The Agent needs scoped object read or edit tools. |
| Database | [`db()`](/docs/capabilities/db) | The Agent needs guarded SQL query, schema, or mutation tools. |
| Email | [`email()`](/docs/capabilities/email) | Send authorized plain-text messages through the configured Email primitive. |
| Sandbox execution | [`sandbox()`](/docs/capabilities/sandbox) | The Agent may run an allowlisted executable in an isolated runtime. |
| Schedules | [`schedule()`](/docs/capabilities/schedule) | The Agent declares scheduled invocations or manages Runtime Schedules through tools. |

### External context

| Ability | Capability | Use it when |
| --- | --- | --- |
| Repository host | [`repositoryHost()`](/docs/capabilities/repository-host) | The Agent needs provider-hosted repository, Change Request, issue, comment, check, or status data through a configured Repository Host client. |
| Repository host context | [`repositoryHostContext()`](/docs/capabilities/repository-host-context) | Read issue or Change Request data identified by a trigger or host. |
| MCP servers | [`mcp()`](/docs/capabilities/mcp) | Add tools from external MCP servers to the Agent. |
| Web search | [`webSearch()`](/docs/capabilities/web-search) | The Agent needs model web search or normalized web search/read tools. |
| Fetch tools | [`fetch()`](/docs/capabilities/fetch) | The Agent needs named HTTP tools for developer-approved endpoints. |
| OpenAPI tools | [`openapi()`](/docs/capabilities/openapi) | The Agent needs a selected OpenAPI operation catalog exposed as bounded HTTP tools or a generated Capability CLI. |
| Transcription | [`transcribe()`](/docs/capabilities/transcribe) | Turn audio input into text before model execution. |
| Gmail | [`gmail()`](/docs/capabilities/gmail) | Search Gmail or create unsent drafts through structured tools. |

### Decisions and output

| Ability | Capability | Use it when |
| --- | --- | --- |
| LLM routing | [`llmRoute()`](/docs/capabilities/llm-route) | Choose one developer-defined route with a model before the invocation. |
| LLM gate | [`llmGate()`](/docs/capabilities/llm-gate) | Allow or reject a request with a model before the invocation. |
| Rate limit | [`rateLimit()`](/docs/capabilities/rate-limit) | Consume a trusted invocation budget before the Agent runs. |
| Title | [`title()`](/docs/capabilities/title) | Generate a title for Agent output, finish extensions, or Channel threads. |
| Chat summary | [`chatSummary()`](/docs/capabilities/chat-summary) | Replace a summary command with a conversation summary. |
| Progress summary | [`progressSummary()`](/docs/capabilities/progress-summary) | Summarize current reasoning and tool activity while an Agent streams. |
| Papercut reports | [`papercuts()`](/docs/capabilities/papercuts) | Report small runtime or developer-experience problems to application code. |
| Usage | [`usage()`](/docs/capabilities/usage) | Request provider usage metadata and expose a normalized Agent Usage Record. |
| Cost | [`cost()`](/docs/capabilities/cost) | Add exact and display-ready USD cost to Agent Usage Records. |

## Next steps

- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Capabilities API](/docs/capabilities)
- [Agent definitions](/docs/agents/agent-definitions)
