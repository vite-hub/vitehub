---
title: Official capabilities
description: Use the official Capability catalog by agent ability, not by package boundary.
navigation.title: Official capabilities
navigation.order: 2
navigation.group: Start here
icon: i-lucide-list-checks
---

Official Capabilities are public factories exported from `@vite-hub/agent/capabilities`.
Use them when the Agent needs a named ability that ViteHub owns end to end, including requirements, runtime behavior, driver contributions, and inspection metadata.

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
  inputCommands,
  kv,
  llmGate,
  llmRoute,
  mcp,
  memory,
  openapi,
  papercuts,
  rateLimit,
  repositoryHost,
  sandbox,
  schedule,
  skills,
  subagents,
  transcribe,
  webSearch,
  workspaceShell,
} from '@vite-hub/agent/capabilities'
```

## Catalog

### Invocation

| Ability | Capability | Use it when |
| --- | --- | --- |
| Invocation access | [`access()`](/docs/capabilities/access) | Trusted invocation identity should narrow chat admission or Workspace Scope before later Capabilities run. |
| Chat behavior | [`chat()`](/docs/capabilities/chat) | A chat surface should start Agent Invocations and manage Chat History behavior. |
| Input commands | [`inputCommands()`](/docs/capabilities/input-commands) | Explicit user commands should transform or enrich input before the Agent runs. |
| Subagents | [`subagents()`](/docs/capabilities/subagents) | An Agent should delegate bounded work to named Agent Definitions through tools. |

### Workspace

| Ability | Capability | Use it when |
| --- | --- | --- |
| Browser automation | [`browser()`](/docs/capabilities/browser) | The Agent needs headless browser evidence through the global `bash` tool and an included browser skill file. |
| Workspace files | [`workspaceShell()`](/docs/capabilities/workspace-shell) | The Agent should inspect or edit Workspace files, or run allowlisted Workspace-session commands, through constrained Workspace tools. |
| Git source history | [`git()`](/docs/capabilities/git) | The Agent needs bounded Git source-history inspection or local Workspace Session git state selection. |
| Skills file | [`skills()`](/docs/capabilities/skills) | The Agent requires a Workspace skill file at invocation time. |
| Durable memory | [`memory()`](/docs/capabilities/memory) | The Agent needs scoped durable records across invocations. |

### Runtime primitives

| Ability | Capability | Use it when |
| --- | --- | --- |
| KV storage | [`kv()`](/docs/capabilities/kv) | The Agent needs scoped key-value read or edit tools. |
| Blob storage | [`blob()`](/docs/capabilities/blob) | The Agent needs scoped object read or edit tools. |
| Database | [`db()`](/docs/capabilities/db) | The Agent needs guarded SQL query, schema, or mutation tools. |
| Email | [`email()`](/docs/capabilities/email) | The Agent should send authorized plain-text messages through the configured Email primitive. |
| Sandbox execution | [`sandbox()`](/docs/capabilities/sandbox) | The Agent may run an allowlisted executable in an isolated runtime. |
| Schedules | [`schedule()`](/docs/capabilities/schedule) | The Agent declares scheduled invocations or manages Runtime Schedules through tools. |

### External context

| Ability | Capability | Use it when |
| --- | --- | --- |
| Repository host | [`repositoryHost()`](/docs/capabilities/repository-host) | The Agent needs provider-hosted repository, Change Request, issue, comment, check, or status data through a configured Repository Host client. |
| MCP servers | [`mcp()`](/docs/capabilities/mcp) | External MCP server tools should become model-facing Agent tools. |
| Web search | [`webSearch()`](/docs/capabilities/web-search) | The Agent needs model web search or normalized web search/read tools. |
| Fetch tools | [`fetch()`](/docs/capabilities/fetch) | The Agent needs named HTTP tools for developer-approved endpoints. |
| OpenAPI tools | [`openapi()`](/docs/capabilities/openapi) | The Agent needs a selected OpenAPI operation catalog exposed as bounded HTTP tools or a generated Capability CLI. |
| Transcription | [`transcribe()`](/docs/capabilities/transcribe) | Audio input parts should become text before model execution. |

### Decisions and output

| Ability | Capability | Use it when |
| --- | --- | --- |
| LLM routing | [`llmRoute()`](/docs/capabilities/llm-route) | A pre-invocation model decision should choose one developer-defined route. |
| LLM gate | [`llmGate()`](/docs/capabilities/llm-gate) | A pre-invocation model decision should allow or reject the request. |
| Rate limit | [`rateLimit()`](/docs/capabilities/rate-limit) | A trusted invocation budget should be consumed before the Agent runs. |
| Title | [`title()`](/docs/capabilities/title) | Agent output, finish extensions, or compatible Channel threads should include a generated title. |
| Chat summary | [`chatSummary()`](/docs/capabilities/chat-summary) | A summary command should replace explicit input with a conversation summary. |
| Papercut reports | [`papercuts()`](/docs/capabilities/papercuts) | An Agent should report small runtime or developer-experience friction to an application-owned sink. |

## Read capability pages first

Each capability page starts with installation and configuration, then shows runtime behavior, requirements, driver support, options, inspection path, and related reference links.
Avoid copying option shapes between Capabilities unless the public factory exposes the same type.

## Read next

- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Capabilities API](/docs/capabilities)
- [Agent definitions](/docs/agents/agent-definitions)
