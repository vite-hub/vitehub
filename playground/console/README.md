# Console playground

Run the real Console client against deterministic, synthetic data:

```bash
pnpm exec vp run console:dev
```

Open <http://localhost:5173/_vitehub/>. Console components and `@vite-hub/ui`
load directly from source, so UI edits use Vite hot module replacement.

The Agent Invocation records live in `console.fixture.json`. `mock-api.ts` adds
the read-only Usage, KV, Workflow, Queue, and search responses needed by the
Console. `rpc.ts` connects the Console's SSE RPC transport to those local fixture
routes. Usage filters and pagination use the real usage aggregation code.
This playground does not change the Console routes generated for Vite
or Nuxt applications.

To share the running playground temporarily, expose the same local server:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

Quick Tunnel URLs are public and have no uptime guarantee. Keep playground data
synthetic.
