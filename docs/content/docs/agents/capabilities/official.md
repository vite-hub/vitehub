---
title: Official capabilities
description: Find the built-in Capability for what your Agent needs to do, such as Blob, Browser, Email, MCP, Sandbox, or Channel delivery.
navigation.title: Official capabilities
navigation.order: 22
navigation.group: Instructions and tools
icon: i-lucide-list-checks
navigation.kind: Reference
---

A Capability gives an Agent one ability. Pick one below by task. Each page shows setup, what the Agent gets, and how to verify it.

Import factories from `vite-hub/agent/capabilities`. [Attach a Capability](/docs/agents/capabilities#attach-a-capability) shows a full example. Server Primitive Capabilities are documented next to their server API.

## Catalog

### Invocation

| Ability | Capability | Use it when |
| --- | --- | --- |
| Invocation access | [`access()`](/docs/agents/capabilities/access) | Limit chat admission or Workspace access by trusted caller identity. |
| Chat behavior | [`chat()`](/docs/agents/capabilities/chat) | Start the Agent from chat messages and keep Chat History. |
| Input commands | [`inputCommands()`](/docs/agents/capabilities/input-commands) | Transform command input, such as `/summary`, before the run. |

### Workspace

| Ability | Capability | Use it when |
| --- | --- | --- |
| Browser automation | [`browser()`](/docs/browser/agent-capability) | Give a Provider Agent a managed headless browser, browser guidance, and screenshot delivery. |
| Workspace files | [`workspaceShell()`](/docs/workspace/agent-capability) | Read or edit Workspace files, or run configured commands. |
| Git source history | [`git()`](/docs/agents/capabilities/git) | Read bounded Git history, or select a local Workspace Session's Git state. |
| Skills file | [`skills()`](/docs/agents/capabilities/skills) | Require a Workspace skill file at run time. |
| Durable memory | [`memory()`](/docs/agents/capabilities/memory) | Keep scoped records between runs. |

### Runtime primitives

| Ability | Capability | Use it when |
| --- | --- | --- |
| KV storage | [`kv()`](/docs/kv/agent-capability) | Read or edit scoped key-value data. |
| Blob storage | [`blob()`](/docs/blob/agent-capability) | Read or edit scoped objects. |
| Database | [`db()`](/docs/database/agent-capability) | Guarded SQL queries, schema, or writes. |
| Content | [`content()`](/docs/content/agent-capability) | Read, draft, publish, and schedule Content documents, checked by the `authorize` policy. |
| i18n | [`i18n()`](/docs/i18n/agent-capability) | Find missing translations, save drafts, and publish them with approval, without a deploy. |
| Email | [`email()`](/docs/email/agent-capability) | Send authorized plain-text email through the Email primitive. |
| Channel delivery | [`channelDelivery()`](/docs/channels/agent-capability) | Send the result through a Channel to a recipient your app picks. |
| Sandbox execution | [`sandbox()`](/docs/sandbox/agent-capability) | Run an allowlisted program in isolation. |
| OTLP telemetry | [`otlp()`](/docs/agents/capabilities/otlp) | Export live events and traces to an OpenTelemetry receiver. |
| Papercut reporting | [`papercuts()`](/docs/agents/capabilities/papercuts) | Report small failures and wasted work to your app's sink. |
| Operational diagnostics | [`diagnostics()`](/docs/agents/capabilities/diagnostics) | Send run outcomes and resource data to your app's reporter. |

### External context

| Ability | Capability | Use it when |
| --- | --- | --- |
| MCP servers | [`mcp()`](/docs/agents/capabilities/mcp) | Add tools from MCP servers, such as an Executor catalog. |
| Web search | [`webSearch()`](/docs/agents/capabilities/web-search) | Model web search, or normalized search and read tools. |
| Fetch tools | [`fetch()`](/docs/agents/capabilities/fetch) | Named tools for HTTP endpoints you approve. |
| OpenAPI tools | [`openapi()`](/docs/agents/capabilities/openapi) | Selected OpenAPI operations as bounded HTTP tools or a generated CLI. |
| Transcription | [`transcribe()`](/docs/agents/capabilities/transcribe) | Turn audio into text before the model runs. |
| Forge | [`forge()`](/docs/agents/capabilities/forge) | Read and change repositories on GitHub, GitLab and Forgejo. |
| Gmail | [`gmail()`](/docs/agents/capabilities/gmail) | Search and read Gmail or create unsent drafts through a Google Connection. |

### Decisions and output

| Ability | Capability | Use it when |
| --- | --- | --- |
| Rate limit | [`rateLimit()`](/docs/rate-limit/agent-capability) | Consume a trusted invocation budget before the Agent runs. |
| Invocation budget | [`budget()`](/docs/agents/capabilities/budget) | Observe or enforce per-invocation token and USD limits. |
| Title | [`title()`](/docs/agents/capabilities/title) | Generate a title for Agent output, finish extensions, or Channel threads. |
| Progress summary | [`progressSummary()`](/docs/agents/capabilities/progress-summary) | Summarize reasoning and tool activity while streaming. |
| Usage | [`usage()`](/docs/agents/capabilities/usage) | Normalized provider tokens and cost. |

## Next steps

- [Custom capabilities](/docs/agents/capabilities/custom)
- [Capabilities API](/docs/agents/capabilities)
- [Agent definitions](/docs/agents/agent-definitions)
