# Console playground

Run the real Console client against deterministic, synthetic data:

```bash
pnpm exec vp run console:dev
```

Open <http://localhost:5173/_vitehub/>. Console components and `@vite-hub/ui`
load directly from source, so UI edits use Vite hot module replacement.

The `Review image attachments` session covers persisted input and output images with landscape and portrait fixtures. `mock-rpc.ts` connects the Console's RPC calls to the synthetic HTTP responses.

`meal-logger` is a retired Agent. Its session stays in invocation history, so search lists it under Invocation history and the Agents list does not show it.

The `Inspect MCP tools and title` session provides synthetic server groups, tool contracts, skipped and empty servers, and a completed Title view for the Capabilities tab.

The `Share one empty state across primitive pages` session is the happy path: a configured Agent, a prepared workspace, reasoning, file reads, commands with output, a file change with diffs, commentary, a Markdown answer, a GitHub reply, and usage with cost. The `Sync docs for the 0.0.5 release` session fails while it prepares the workspace, so the preparation group shows a failed step.

The Agent Invocation records live in `console.fixture.json`. `mock-api.ts` adds
the read-only Usage, KV, Workflow, Queue, and search responses needed by the
Console. `rpc.ts` connects the Console's SSE RPC transport to those local fixture
routes. It also serves a synthetic Connections management API
with three OAuth Connections, one API key Connection, their activity, and one pending approval. Usage filters and pagination use the real usage aggregation code.
Blob, Databases, Email, Rate Limits, Sandboxes, Workspaces, Schedules, Workflows, and Queues answer from synthetic stores, records, and definitions in `mock-api.ts`, so every Console section renders without a provider. The Email outbox uses the real development outbox driver and Console reader.
This playground does not change the Console routes generated for Vite
or Nuxt applications.

To share the running playground temporarily, expose the same local server:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

Quick Tunnel URLs are public and have no uptime guarantee. Keep playground data
synthetic.
