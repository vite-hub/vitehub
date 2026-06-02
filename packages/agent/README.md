# @vite-hub/agent

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="AI SDK" src="https://img.shields.io/badge/AI%20SDK-models-111827?style=flat-square">
</p>

`@vite-hub/agent` defines model-backed agents from files such as `server/agents/support/config.ts`.

Keep the three pieces separate:

- **AI package**: the AI SDK model and streaming runtime.
- **Capabilities**: opt-in abilities such as chat, shell, search, storage, sandbox, and MCP tools.
- **Workspace**: file-system context the agent can inspect, reason from, and optionally update while doing a task.

## Install

```sh
pnpm add @vite-hub/agent @vite-hub/workspace ai
```

Add the AI SDK model provider you pass to `model`.

## Minimal API

```ts
// server/agents/support/config.ts
import { gateway } from "@ai-sdk/gateway"
import { defineAgent } from "@vite-hub/agent"
import { chat, workspaceShell } from "@vite-hub/agent/capabilities"
import { source } from "@vite-hub/workspace"

export default defineAgent({
  model: gateway("openai/gpt-5.1-mini"),
  instructions: "Answer support questions from the workspace.",
  capabilities: [chat(), workspaceShell()],
  workspace: {
    sources: {
      support: source.file("support.md"),
    },
  },
})
```

```ts
// vite.config.ts
import { hubAgent } from "@vite-hub/agent/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubWorkspace(), hubAgent(), nitro()],
})
```

## Capabilities

- `chat()` exposes the agent as a chat surface; see the [AI agent tutorial](https://vitehub.dev/docs/tutorials/build-ai-chatbot).
- `workspaceShell()` runs scoped shell/file work through [`@vite-hub/shell`](../shell/README.md).
- `webSearch()` searches and reads the web with [Brave](https://brave.com/search/api/), [Exa](https://docs.exa.ai/), [Jina](https://jina.ai/en-US/reader/), [SearXNG](https://docs.searxng.org/dev/search_api.html), [SerpApi](https://serpapi.com/search-api), [SerpBase](https://serpbase.dev/docs), or [Tavily](https://docs.tavily.com/).
- `transcribe()` uses the [AI SDK transcription API](https://ai-sdk.dev/docs/reference/ai-sdk-core/transcribe).
- `mcp()` connects tools from [Model Context Protocol](https://modelcontextprotocol.io/) servers through `@ai-sdk/mcp`.
- `kv()`, `blob()`, and `db()` expose [`@vite-hub/kv`](../kv/README.md), [`@vite-hub/blob`](../blob/README.md), and [`@vite-hub/database`](../database/README.md).
- `sandbox()` and `schedule()` expose [`@vite-hub/sandbox`](../sandbox/README.md) and [`@vite-hub/schedule`](../schedule/README.md).
- `skills()`, `access()`, `memory()`, `fetch()`, `llmRoute()`, `llmGate()`, and `usageTelemetry()` cover prompt skills, workspace scope, durable notes, HTTP reads, pre-run decisions, and usage reporting.

## Built on

Vite discovers agent files and ViteHub generates the host route/runtime state for the active server host. Model execution uses [AI SDK](https://ai-sdk.dev/docs); provider tools stay capability-scoped instead of becoming one global agent config.

Learn more at [vitehub.dev](https://vitehub.dev).
