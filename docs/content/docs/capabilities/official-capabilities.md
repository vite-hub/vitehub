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
  chatTitle,
  db,
  fetch,
  git,
  inputCommands,
  kv,
  llmGate,
  llmRoute,
  mcp,
  memory,
  observability,
  openapi,
  rateLimit,
  repositoryHost,
  repositoryHostContext,
  sandbox,
  schedule,
  skills,
  subagents,
  transcribe,
  usageTelemetry,
  webSearch,
  workspaceShell,
} from '@vite-hub/agent/capabilities'
```

## Catalog

| Ability | Capability | Use it when |
| --- | --- | --- |
| Invocation access | [`access()`](/docs/capabilities/access) | Trusted invocation identity should narrow chat admission or Workspace Scope before later Capabilities run. |
| Chat behavior | [`chat()`](/docs/capabilities/chat) | A chat surface should start Agent Invocations and manage Chat History behavior. |
| Input commands | [`inputCommands()`](/docs/capabilities/input-commands) | Explicit user commands should transform or enrich input before the Agent runs. |
| Subagents | [`subagents()`](/docs/capabilities/subagents) | A model-backed Agent should delegate bounded work to named Agent Definitions through model-facing tools. |
| Browser automation | [`browser()`](/docs/capabilities/browser) | The Agent needs headless browser evidence through the global `bash` tool and an included browser skill file. |
| Workspace files | [`workspaceShell()`](/docs/capabilities/workspace-shell) | The Agent should inspect or edit Workspace files, or run allowlisted Workspace-session commands, through constrained Workspace tools. |
| Git source history | [`git()`](/docs/capabilities/git) | The Agent needs bounded Git source-history inspection or local Workspace Session git state selection. |
| Repository host | [`repositoryHost()`](/docs/capabilities/repository-host) | The Agent needs provider-hosted repository, Change Request, issue, comment, check, or status data through a configured Repository Host client. |
| Repository host context | [`repositoryHostContext()`](/docs/capabilities/repository-host-context) | A trigger or host knows the current issue or Change Request and runtime code should read related context lazily. |
| Skills file | [`skills()`](/docs/capabilities/skills) | The Agent requires a Workspace skill file at invocation time. |
| KV storage | [`kv()`](/docs/capabilities/kv) | The Agent needs scoped key-value read or edit tools. |
| Blob storage | [`blob()`](/docs/capabilities/blob) | The Agent needs scoped object read or edit tools. |
| Database | [`db()`](/docs/capabilities/db) | The Agent needs guarded SQL query, schema, or mutation tools. |
| Sandbox execution | [`sandbox()`](/docs/capabilities/sandbox) | The Agent may run an allowlisted executable in an isolated runtime. |
| Schedules | [`schedule()`](/docs/capabilities/schedule) | The Agent declares scheduled invocations or manages Runtime Schedules through tools. |
| MCP servers | [`mcp()`](/docs/capabilities/mcp) | External MCP server tools should become model-facing Agent tools. |
| Web search | [`webSearch()`](/docs/capabilities/web-search) | The Agent needs model web search or normalized web search/read tools. |
| Fetch tools | [`fetch()`](/docs/capabilities/fetch) | The Agent needs named HTTP tools for developer-approved endpoints. |
| OpenAPI tools | [`openapi()`](/docs/capabilities/openapi) | The Agent needs a selected OpenAPI operation catalog exposed as bounded HTTP tools or a generated Capability CLI. |
| Transcription | [`transcribe()`](/docs/capabilities/transcribe) | Audio input parts should become text before model execution. |
| Durable memory | [`memory()`](/docs/capabilities/memory) | The Agent needs scoped durable records across invocations. |
| LLM routing | [`llmRoute()`](/docs/capabilities/llm-route) | A pre-invocation model decision should choose one developer-defined route. |
| LLM gate | [`llmGate()`](/docs/capabilities/llm-gate) | A pre-invocation model decision should allow or reject the request. |
| Rate limit | [`rateLimit()`](/docs/capabilities/rate-limit) | A trusted invocation budget should be checked or consumed before the Agent runs. |
| Chat title | [`chatTitle()`](/docs/capabilities/chat-title) | Chat streams and finish extensions should include a generated conversation title. |
| Chat summary | [`chatSummary()`](/docs/capabilities/chat-summary) | A summary command should replace explicit input with a conversation summary. |
| Observability (deprecated) | [`observability()`](/docs/capabilities/observability) | Existing code still needs the legacy lifecycle callback or finish extension while migrating to built-in invocation traces. |
| Usage telemetry (deprecated) | [`usageTelemetry()`](/docs/capabilities/usage-telemetry) | Existing code still needs the legacy flat primitive usage extension while migrating to `invocation.usage`. |

## Read capability pages first

Each capability page starts with installation and configuration, then shows runtime behavior, requirements, driver support, options, inspection path, and related reference links.
Avoid copying option shapes between Capabilities unless the public factory exposes the same type.

## Read next

- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Capabilities API](/docs/capabilities)
- [Agent definitions](/docs/agents/agent-definitions)
