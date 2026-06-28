# @vite-hub/agent

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="AI SDK" src="https://img.shields.io/badge/AI%20SDK-v7-111827?style=flat-square">
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

`ai` is required for model-backed drivers and AI SDK-powered capabilities such as model-backed `chatTitle()`, `chatSummary()`, `llmGate()`, and `transcribe()`. Agents with a custom `run()` function can bundle without installing `ai`.

Add the AI SDK model provider you pass to `model`.

For AI SDK harness drivers, add the harness packages:

```sh
pnpm add @ai-sdk/harness @ai-sdk/harness-codex @ai-sdk/sandbox-vercel
```

## Minimal API

```ts
// server/agents/support/config.ts
import { gateway } from "@ai-sdk/gateway"
import { defineAgent } from "@vite-hub/agent"
import { chat, workspaceShell } from "@vite-hub/agent/capabilities"
import { file } from "@vite-hub/workspace"

export default defineAgent({
  driver: {
    model: gateway("openai/gpt-5.1-mini"),
    instructions: [
      "Answer support questions from the workspace.",
      "{{ workspace.sources }}",
    ],
  },
  capabilities: [chat(), workspaceShell()],
  workspace: {
    sources: {
      support: file({
        path: "support.md",
        instructions: "Use this source for support policies and known answers.",
      }),
    },
  },
})
```

## Harness drivers

Harness-backed agents use AI SDK `HarnessAgent` behind the ViteHub Agent Driver boundary.

```ts
// server/agents/codex/config.ts
import { createCodex } from "@ai-sdk/harness-codex"
import { defineAgent } from "@vite-hub/agent"
import { skills } from "@vite-hub/agent/capabilities"
import { createLocalHarnessSandbox } from "@vite-hub/agent/harness/local-sandbox"
import { file } from "@vite-hub/workspace"

export default defineAgent({
  driver: {
    harness: createCodex({
      model: "gpt-5.5",
      reasoningEffort: "low",
    }),
    sandbox: createLocalHarnessSandbox(),
    credentials: { label: "local Codex", source: "ambient" },
  },
  workspace: {
    mode: "write",
    sources: {
      guide: file("AGENTS.md"),
    },
  },
  capabilities: [
    skills({ path: ".agents/skills/review" }),
  ],
})
```

`driver.harness` is the AI SDK harness adapter instance. `driver.sandbox` can provide an AI SDK sandbox provider; when omitted, ViteHub uses the AI SDK Vercel Sandbox default for bridge-backed harnesses. `createLocalHarnessSandbox()` is a trusted-host sandbox for local development and Agent Evals, not a production isolation boundary. `driver.harness`, `driver.sandbox`, and `driver.sessionKey` can also be callbacks when one Agent Definition needs invocation-scoped harness setup. Workspace-backed harness drivers receive a Harness Workspace Session prepared from the selected Workspace. When `access()` narrows Workspace Scope, ViteHub materializes only that selected scope plus generated source descriptors. Read mode materializes files and discards sandbox changes; write mode syncs additions, updates, and deletions back through Workspace rules. V1 configures built-in harness permissions internally with the no-approval policy and does not expose a public permission option. Skills stay a Capability through `skills()` rather than becoming a root Agent Definition field. For harness drivers, `skills()` relies on mounted Workspace files and does not inject model instructions or Workspace Shell tools. Put harness guidance in Workspace files such as `AGENTS.md`; model-facing Source Instructions are not forwarded to harness-backed Agent Drivers yet. Unsupported model-facing Capability contributions are rejected before harness execution with the contributing Capability id in the error.

```ts
// vite.config.ts
import { hubAgent } from "@vite-hub/agent/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubWorkspace(), hubAgent()],
})
```

## Capabilities

- `chat()` exposes the agent as a chat surface; see the [First Agent guide](https://vitehub.dev/docs/getting-started/first-agent).
- `workspaceShell()` runs scoped shell/file work through [`@vite-hub/shell`](../shell/README.md).
- `webSearch()` searches and reads the web with [Brave](https://brave.com/search/api/), [Exa](https://docs.exa.ai/), [Jina](https://jina.ai/en-US/reader/), [SearXNG](https://docs.searxng.org/dev/search_api.html), [SerpApi](https://serpapi.com/search-api), [SerpBase](https://serpbase.dev/docs), or [Tavily](https://docs.tavily.com/).
- `openapi()` turns an allowed OpenAPI `operationId` subset into bounded HTTP tools, or into a generated Capability CLI when `cli` is set.
- `transcribe()` uses the [AI SDK transcription API](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/transcribe).
- `mcp()` connects tools from [Model Context Protocol](https://modelcontextprotocol.io/) servers through `@ai-sdk/mcp`.
- `kv()`, `blob()`, and `db()` expose [`@vite-hub/kv`](../kv/README.md), [`@vite-hub/blob`](../blob/README.md), and [`@vite-hub/database`](../database/README.md).
- `sandbox()` and `schedule()` expose [`@vite-hub/sandbox`](../sandbox/README.md) and [`@vite-hub/schedule`](../schedule/README.md).
- `skills()`, `access()`, `memory()`, `fetch()`, `llmRoute()`, `llmGate()`, and `usageTelemetry()` cover prompt skills, workspace scope, durable notes, HTTP reads, pre-run decisions, and usage reporting.

```ts
import { openapi } from "@vite-hub/agent/capabilities"

openapi({
  spec: "https://api.example.com/openapi.json",
  cli: {
    name: "billing",
    description: "Inspect live billing API data.",
  },
  operations: ["billingListCustomers", "billingGetInvoice", "billingCreateTicket"],
  request: {
    hidden: { body: ["tenantId"] },
    onRequest({ context, request }) {
      request.body = {
        tenantId: context.get<{ tenantId: string }>("billing")?.tenantId,
        ...(request.body as Record<string, unknown> | undefined),
      }
      request.headers.set("authorization", `Bearer ${context.get<{ token: string }>("billing")?.token}`)
    },
  },
  transformResponse: (response, { operation }) => ({
    operationId: operation.id,
    response,
  }),
})
```

`spec` can be a callback when the OpenAPI document comes from the current Agent Invocation context. Request servers come from OpenAPI `servers`; use `server` only as an override escape hatch when the spec has no usable server.
When `cli` is set, the operation tools are replaced by one CLI-named tool. ViteHub generates one subcommand per allowed operation, using the OpenAPI operation summary or description for command guidance.
Custom Capability authors still define `cli` as a flat command tree; generated command trees stay behind adapter-owned options such as `openapi({ cli })`.

## Chat state

Chat History and the Concurrent Invocation Guard need an Agent State Provider when they should survive a process restart. Hosted Node deployments use memory state by default outside Cloudflare, so they should configure a durable provider explicitly.

```ts
// vite.config.ts
export default defineConfig({
  agent: {
    providers: {
      state: {
        provider: "sqlite",
        url: process.env.VITEHUB_AGENT_STATE_URL,
      },
    },
  },
})
```

`provider: "sqlite"` uses the built-in libSQL-compatible state backend, so `file:` URLs work for local SQLite and hosted libSQL URLs work for remote deployments.

You can also wire the adapter manually when `chat({ state })` should own the state provider:

```ts
import { createLibsqlAgentState } from "@vite-hub/agent/state/sqlite"

chat({
  state: () => createLibsqlAgentState({
    url: process.env.VITEHUB_AGENT_STATE_URL!,
  }),
})
```

This is not the Database Capability. It is Agent-owned runtime state for chat behavior.

## Built on

Vite discovers agent files and ViteHub generates the host route/runtime state for the active server host. Model execution uses [AI SDK](https://ai-sdk.dev/docs); provider tools stay capability-scoped instead of becoming one global agent config.

Learn more at [vitehub.dev](https://vitehub.dev).
