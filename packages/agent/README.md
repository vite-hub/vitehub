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

`ai` is required for model-backed drivers and AI SDK-powered capabilities such as model-backed `chatTitle()`, `chatSummary()`, `llmGate()`, and `transcribe()`. Agents with `driver.run` can bundle without installing `ai`.

Add the AI SDK model provider you pass to `model`.

For AI SDK harness drivers, add the harness package you use:

```sh
pnpm add @ai-sdk/harness @ai-sdk/harness-codex
# or
pnpm add @ai-sdk/harness @ai-sdk/harness-claude-code
```

For non-local omitted sandbox fallback, also add `@ai-sdk/sandbox-vercel`.

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
      "Use the support Source for support policies and known answers.",
    ],
  },
  capabilities: [chat(), workspaceShell()],
  workspace: {
    sources: {
      support: file({
        path: "support.md",
      }),
    },
  },
})
```

## Harness drivers

Harness-backed agents use AI SDK `HarnessAgent` behind the ViteHub Agent Driver boundary.

```ts
// server/agents/codex/config.ts
import { defineAgent } from "@vite-hub/agent"
import { skills } from "@vite-hub/agent/capabilities"
import { codexDriver } from "@vite-hub/agent/harness/codex"
import { file } from "@vite-hub/workspace"

export default defineAgent({
  driver: codexDriver({
    model: "gpt-5.5",
    reasoningEffort: "low",
  }),
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

For Claude Code, use `claudeCodeDriver()` from `@vite-hub/agent/harness/claude-code`. It accepts `createClaudeCode()` settings such as `auth`, `model`, and `maxTurns`, and uses the same local sandbox default unless `sandbox: false` is set.

`driver.harness` is the AI SDK harness adapter instance. Workspace-backed harness drivers in Vite dev use ViteHub's local harness sandbox by default and receive a Harness Workspace Session prepared from the selected Workspace. The local sandbox is a tempdir-backed shell convenience, not OS/process isolation; pass a real harness sandbox provider through `driver.sandbox` when isolation matters. Outside the local workspace path, ViteHub uses the AI SDK Vercel Sandbox default when `@ai-sdk/sandbox-vercel` is installed. Harness sandbox provider setup is Agent Package runtime plumbing; use `driver.sandbox` when an Agent needs a specific harness process or session provider. Add `sandbox({ commands })` only when the model should receive `sandbox_exec`. `driver.harness`, `driver.sessionKey`, and `driver.sandbox` can be callbacks when one Agent Definition needs invocation-scoped harness setup. When `access()` narrows Workspace Scope, ViteHub materializes only that selected scope plus generated source descriptors. Read mode materializes files and discards sandbox changes; write mode syncs additions, updates, and deletions back through Workspace rules. V1 configures built-in harness permissions internally with the no-approval policy and does not expose a public permission option. Skills stay a Capability through `skills()` rather than becoming a root Agent Definition field. For harness drivers, `skills()` relies on mounted Workspace files and does not inject model instructions or Workspace Shell tools. Put harness guidance in Workspace files such as `AGENTS.md`; Sources, Capabilities, and Skills do not inject extra model instructions by default.

For model-backed drivers, put free-form guidance for configured Sources, Capabilities, and Skills in `driver.instructions` or a deterministic imported instruction file. Tool descriptions and schemas stay with the tools as structured contracts.

```ts
// vite.config.ts
import { hubAgent } from "@vite-hub/agent/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubWorkspace(), hubAgent()],
})
```

## DevTools inspection

With `hubAgent()` and the ViteHub DevTools shell active, open the Agent Chat feature and type `//inspect`.
DevTools handles this Host Command locally and adds a transcript summary of the resolved Agent Definition surface without sending the command to the Agent.
Use it to verify the selected driver, tools, Workspace files and Sources, instructions, Agent Invoker Profiles, warnings, and metadata status before debugging model output.

## Capabilities

- `chat()` exposes the agent as a chat surface; see the [First Agent guide](https://vitehub.dev/docs/getting-started/first-agent).
- `workspaceShell()` runs scoped shell/file work through [`@vite-hub/shell`](../shell/README.md).
- `webSearch()` searches and reads the web with [Brave](https://brave.com/search/api/), [Exa](https://docs.exa.ai/), [Jina](https://jina.ai/en-US/reader/), [SearXNG](https://docs.searxng.org/dev/search_api.html), [SerpApi](https://serpapi.com/search-api), [SerpBase](https://serpbase.dev/docs), or [Tavily](https://docs.tavily.com/).
- `openapi()` turns an allowed OpenAPI `operationId` subset into bounded HTTP tools, or into a generated Capability CLI when `cli` is set.
- `transcribe()` uses the [AI SDK transcription API](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/transcribe).
- `mcp()` connects tools from [Model Context Protocol](https://modelcontextprotocol.io/) servers through `@ai-sdk/mcp`.
- `kv()`, `blob()`, and `db()` expose [`@vite-hub/kv`](../kv/README.md), [`@vite-hub/blob`](../blob/README.md), and [`@vite-hub/database`](../database/README.md).
- `sandbox()` and `schedule()` expose [`@vite-hub/sandbox`](../sandbox/README.md) and [`@vite-hub/schedule`](../schedule/README.md).
- `skills()`, `access()`, `memory()`, `fetch()`, `llmRoute()`, and `llmGate()` cover prompt skills, workspace scope, durable notes, HTTP reads, and pre-run decisions.
- Finish hooks and Channel Delivery finish effects can read structured usage from `event.usage` and `context.usage`.

```ts
import { openapi } from "@vite-hub/agent/capabilities"

openapi({
  spec: "https://api.example.com/openapi.json",
  cli: {
    name: "billing",
    description: "Inspect live billing API data.",
  },
  operations: ["billingListCustomers", "billingGetInvoice", "billingCreateTicket"],
  hooks: {
    request: {
      provides: {
        body: ["tenantId"],
      },
      handler({ context, request }) {
        request.body = {
          ...(request.body as Record<string, unknown> | undefined),
          tenantId: context.get<{ tenantId: string }>("billing")?.tenantId,
        }
        request.headers.set("authorization", `Bearer ${context.get<{ token: string }>("billing")?.token}`)
      },
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
