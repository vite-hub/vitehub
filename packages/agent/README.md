# @vite-hub/agent

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="AI SDK" src="https://img.shields.io/badge/AI%20SDK-v7-111827?style=flat-square">
</p>

`@vite-hub/agent` defines Agents from files such as `server/agents/support/agent.ts`. Each Agent selects one Driver: an AI SDK model, a coding harness, or application-owned `driver.run` logic.

Keep the three pieces separate:

- **Agent Driver**: the model, coding harness, or application-owned function that runs the Agent.
- **Capabilities**: opt-in abilities such as chat, shell, search, storage, sandbox, and MCP tools.
- **Workspace**: file-system context the agent can inspect, reason from, and optionally update while doing a task.

## Install

```sh
pnpm add @vite-hub/agent @vite-hub/workspace ai
```

`ai` is required for model-backed drivers and AI SDK-powered capabilities such as model-backed `title()`, `chatSummary()`, `llmGate()`, and `transcribe()`. Agents with `driver.run` can bundle without installing `ai`.

Add the AI SDK model provider you pass to `model`.

`codexDriver()` includes the exact AI SDK harness packages that ViteHub supports. For Claude Code, add its driver package:

```sh
pnpm add @ai-sdk/harness-claude-code
```

## Minimal API

```ts
// server/agents/support/agent.ts
import { gateway } from "@ai-sdk/gateway"
import { defineAgent } from "@vite-hub/agent"
import { workspaceShell } from "@vite-hub/agent/capabilities"
import { webChat } from "@vite-hub/agent/channels"
import { file } from "@vite-hub/workspace"

export default defineAgent({
  driver: {
    model: gateway("openai/gpt-5.1-mini"),
    instructions: [
      "Answer support questions from the workspace.",
      "Use the support Source for support policies and known answers.",
    ],
  },
  channels: {
    web: webChat(),
  },
  capabilities: [workspaceShell()],
  workspace: {
    sources: {
      support: file({
        path: "support.md",
      }),
    },
  },
});
```

## Harness drivers

Harness-backed agents use AI SDK `HarnessAgent` behind the ViteHub Agent Driver boundary.

```ts
// server/agents/codex/agent.ts
import { defineAgent } from "@vite-hub/agent";
import { codexDriver } from "@vite-hub/agent/harness/codex";
import { file } from "@vite-hub/workspace";

export default defineAgent({
  driver: codexDriver({
    instructions: "Review the exact pull request head before changing code.",
    model: "gpt-5.5",
    reasoningEffort: "low",
    workDir: "repositories/vitehub",
  }),
  workspace: {
    mode: "write",
    sources: {
      guide: file("AGENTS.md"),
    },
  },
});
```

Put Agent-owned Skills under `server/agents/codex/skills/`; discovery materializes them into the Harness Workspace and the isolated Codex profile automatically. Use `skills()` for Workspace-backed or external Source Skills.

For Claude Code, use `claudeCodeDriver()` from `@vite-hub/agent/harness/claude-code`. It accepts `createClaudeCode()` settings such as `auth`, `model`, and `maxTurns`. Set `sandbox: false` to skip the helper-configured sandbox and use the Agent Driver fallback.

`driver.harness` is the AI SDK harness adapter instance. Harness drivers use ViteHub's local harness sandbox by default on process-capable hosts and receive a Harness Workspace Session when the Agent has a Workspace. Cloudflare Agents and Deno require an explicit provider. The local sandbox is a tempdir-backed shell convenience, not OS/process isolation; pass a real harness sandbox provider through `driver.sandbox` when isolation matters. Harness sandbox provider setup is Agent Package runtime plumbing; use `driver.sandbox` when an Agent needs a specific harness process or session provider. `driver.workDir` selects a relative directory inside the sandbox default working directory. Add `sandbox({ commands })` only when the model should receive `sandbox_exec`. `driver.harness`, `driver.instructions`, `driver.sessionKey`, `driver.sandbox`, and `driver.workDir` can be callbacks when one Agent Definition needs invocation-scoped harness setup. ViteHub resolves harness instructions before constructing the AI SDK `HarnessAgent`, so stock harness adapters receive the selected instructions for both generated and streamed turns. When `access()` narrows Workspace Scope, ViteHub materializes only that selected scope plus generated source descriptors. Read mode materializes the selected Workspace into the harness sandbox and discards sandbox changes; write mode syncs additions, updates, and deletions back through Workspace rules. Colocated `skills/` files are merged into the Harness Workspace and supported global profile without replacing existing files. V1 configures built-in harness permissions internally with the no-approval policy and does not expose a public permission option. `skills()` remains available for Workspace-backed and external Source Skills and does not inject model instructions or Workspace Shell tools. Put repository-wide guidance in Workspace files such as `AGENTS.md`; use `driver.instructions` for invocation-specific harness policy.

## Boxes

Use a Box when a harness Agent should boot in one project-declared execution environment. A trusted-host Box uses the host's installed tools while materializing a private Home and sanitized process environment:

```ts
import { defineAgent } from "@vite-hub/agent";
import { codexDriver } from "@vite-hub/agent/harness/codex";
import { trustedHost } from "@vite-hub/box";
import { useServerEnv } from "#vitehub/env/server";

export default defineAgent<any, { ref: string; remote: string; sha: string }>({
  box: {
    runtime: trustedHost({ stateRoot: "/var/lib/vitehub/boxes" }),
    checkout: {
      ref: ({ input }) => input.options?.ref,
      remote: ({ input }) => input.options?.remote,
      sha: ({ input }) => input.options?.sha,
    },
    env: {
      GH_TOKEN: () => useServerEnv().githubToken.unseal(),
    },
    home: {
      files: {
        ".gitconfig": { from: ".vitehub/box/gitconfig" },
        ".codex/config.toml": { from: ".vitehub/box/codex.toml" },
      },
      state: {
        ".codex": {
          key: "babysitter/codex",
          seed: {
            "auth.json": { contents: () => useServerEnv().codexAuthJson.unseal() },
          },
        },
      },
    },
    requires: [{ command: "gh", args: ["auth", "status"] }, "pnpm"],
  },
  driver: codexDriver(),
});
```

`checkout` fetches one invocation-resolved Git ref, verifies its full SHA, and runs the harness in an isolated detached checkout with normal commit and explicit-push behavior. The Box deletes it on completion or boot failure. Use `cwd` instead for a caller-owned authoritative directory; the two modes are mutually exclusive.

`env` and `home.files` are immutable boot inputs. `home.state` is writable, persists CLI refreshes under an exclusive session lease, and resolves its seed only when state does not exist. Every Box gets a private Home; missing declarations fail instead of falling back to the machine's normal Home. `codexDriver()` contributes a generic `codex login status` check, and other CLIs use string or direct-argv `requires` entries without provider-specific Box APIs. Do not combine `box.cwd` or `box.checkout` with Agent Workspace materialization.

For model-backed drivers, put free-form guidance for configured Sources, Capabilities, and Skills in `driver.instructions` or a deterministic imported instruction file. Tool descriptions and schemas stay with the tools as structured contracts.

```ts
// vite.config.ts
import { hubAgent } from "@vite-hub/agent/vite";
import { hubWorkspace } from "@vite-hub/workspace/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubWorkspace(), hubAgent()],
});
```

## DevTools inspection

With `hubAgent()` and Agent DevTools active, start the Vite Development Server and run `vitehub agent info --agent <name>`.
The command reads the resolved Agent Definition metadata without invoking the Agent Driver, so use it to verify the selected Driver, tools, Workspace files and Sources, instructions, Agent Invoker Profiles, warnings, and metadata status before debugging model output.
Pass `--json` for the structured inspection contract.

## Capabilities

- A `webChat()` Channel exposes the generated web chat route. Use `chat()` when an app-owned trigger needs Chat History and `chat.message` behavior without Channel-owned route exposure; see the [First Agent guide](https://vitehub.dev/docs/getting-started/first-agent).
- `workspaceShell()` runs scoped shell/file work through [`@vite-hub/shell`](../shell/README.md).
- `webSearch()` searches and reads the web with [Brave](https://brave.com/search/api/), [Exa](https://docs.exa.ai/), [Jina](https://jina.ai/en-US/reader/), [SearXNG](https://docs.searxng.org/dev/search_api.html), [SerpApi](https://serpapi.com/search-api), [SerpBase](https://serpbase.dev/docs), or [Tavily](https://docs.tavily.com/).
- `openapi()` turns an allowed OpenAPI `operationId` subset into bounded HTTP tools, or into a generated Capability CLI when `cli` is set.
- `papercuts()` lets an Agent report small runtime and developer-experience friction to an application-owned sink, with an optional Capability CLI command.
- `transcribe()` uses the [AI SDK transcription API](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/transcribe).
- `createTranscription()` composes remote asynchronous submission and completion through a provider-neutral driver; `elevenLabsScribe()` is the built-in Scribe v2 adapter.
- `mcp()` connects tools from [Model Context Protocol](https://modelcontextprotocol.io/) servers through `@ai-sdk/mcp`.
- `kv()`, `blob()`, `db()`, and `email()` expose [`@vite-hub/kv`](../kv/README.md), [`@vite-hub/blob`](../blob/README.md), [`@vite-hub/database`](../database/README.md), and [`@vite-hub/email`](../email/README.md).
- `sandbox()` and `schedule()` expose [`@vite-hub/sandbox`](../sandbox/README.md) and [`@vite-hub/schedule`](../schedule/README.md).
- `skills()`, `access()`, `memory()`, `fetch()`, `llmRoute()`, and `llmGate()` cover prompt skills, workspace scope, durable notes, HTTP reads, and pre-run decisions.

```ts
import { openapi } from "@vite-hub/agent/capabilities";

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
        };
        request.headers.set(
          "authorization",
          `Bearer ${context.get<{ token: string }>("billing")?.token}`,
        );
      },
    },
  },
  transformResponse: (response, { operation }) => ({
    operationId: operation.id,
    response,
  }),
});
```

`spec` can be a callback when the OpenAPI document comes from the current Agent Invocation context. Request servers come from OpenAPI `servers`; use `server` only as an override escape hatch when the spec has no usable server.
When `cli` is set, the operation tools are replaced by one CLI-named tool. ViteHub generates one subcommand per allowed operation, using the OpenAPI operation summary or description for command guidance.
Capability `cli` can be a static command tree or an invocation resolver that returns `undefined` when the CLI should not be available. Generated command trees stay behind adapter-owned options such as `openapi({ cli })`, whose resolver may return `false` or `undefined` for the current invocation.

## Chat state

Chat History and the Concurrent Invocation Guard need an Agent State Provider when they should survive a process restart. The default `provider: "auto"` uses Cloudflare state on Cloudflare and local SQLite at `file:.data/vitehub-agent-state.sqlite` during Vite development. Production Node and serverless output require `VITEHUB_AGENT_STATE_URL` or explicit provider options because ViteHub cannot infer a durable filesystem there.

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
});
```

`provider: "sqlite"` uses the built-in libSQL-compatible state backend, so `file:` URLs work for local or explicitly persistent Node deployments and hosted libSQL URLs work remotely. Cloudflare, Vercel, and Netlify production output rejects `file:` Agent state before it can write to an ephemeral filesystem.

You can also wire the adapter manually when `chat({ state })` should own the state provider:

```ts
import { createLibsqlAgentState } from "@vite-hub/agent/state/sqlite";

chat({
  state: () =>
    createLibsqlAgentState({
      url: process.env.VITEHUB_AGENT_STATE_URL!,
    }),
});
```

This is not the Database Capability. It is Agent-owned runtime state for chat behavior.

## Built on

Vite discovers Agent files and generates runtime state for the active server host. Route-enabled Channels contribute host routes. Model execution uses [AI SDK](https://ai-sdk.dev/docs); Provider Tools stay Capability-scoped instead of becoming one global Agent config.

Learn more at [vitehub.dev](https://vitehub.dev).
