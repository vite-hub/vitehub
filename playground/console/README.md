# Console playground

Run the real Console client against deterministic, synthetic data:

```bash
pnpm exec vp run console:dev
```

Open <http://localhost:5173/_vitehub/>. Console components, `@vite-hub/ui`, and
the browser modules of Auth, Content, and Realtime load directly from source, so
the playground needs no build and UI edits use Vite hot module replacement.

The `Review image attachments` session covers persisted input and output images with landscape and portrait fixtures. `mock-rpc.ts` connects the Console's RPC calls to the synthetic HTTP responses.

`meal-logger` is a retired Agent. Its session stays in invocation history, so search lists it under Invocation history and the Agents list does not show it.

The `Inspect MCP tools and title` session provides synthetic server groups, tool contracts, skipped and empty servers, and a completed Title view for the Capabilities tab.

The `Share one empty state across primitive pages` session is the happy path: a configured Agent, a prepared workspace, reasoning, file reads, commands with output, a file change with diffs, commentary, a Markdown answer, a GitHub reply, and usage with cost. The `Sync docs for the 0.0.5 release` session fails while it prepares the workspace, so the preparation group shows a failed step.

The Agent Invocation records live in `console.fixture.json`. `mock-api.ts` adds
the read-only Usage, KV, Workflow, Queue, and search responses needed by the
Console. `rpc.ts` connects the Console's SSE RPC transport to those local fixture
routes. It also serves a synthetic Connections management API
with three OAuth Connections, one API key Connection, their activity, and one pending approval. Usage filters and pagination use the real usage aggregation code.
Blob, Databases, Email, Rate Limits, Sandboxes, Workspaces, Schedules, Workflows, and Queues answer from synthetic stores, records, and definitions in `mock-api.ts`, so every Console section renders without a provider. The `passkey` Database table has no rows, so it shows the empty table state. The Email outbox uses the real development outbox driver and Console reader.
This playground does not change the Console routes generated for Vite
or Nuxt applications.

To check Content loading and Rich/Source editing, start this playground on a fixed port and run the browser regression:

```bash
pnpm exec vp dev --config playground/console/vite.config.ts --host 127.0.0.1 --port 3087
# In another terminal, from the repository root:
CONSOLE_TEST_URL=http://127.0.0.1:3087 node --test packages/vite-hub/test/console-content.browser.mjs
```

The check uses installed Playwright Chromium, the real Console components, and intercepted RPC responses with nine synthetic documents. Saves and publishes change only the fixture in that browser test. It covers delayed and failed loads, retry, empty filters, Rich hydration, mode switching, failed saves and publishes, keyboard controls, and mobile layouts. Set `CONSOLE_TEST_ARTIFACTS` to a project-local directory to save screenshots and element bounds. Stop the dev server when the check ends.

To see an error state, set the `playground-fail` cookie to `<route>=<status>` pairs. A route is the path after
`/api/_vitehub/console/`, and it also matches the paths under it:

```js
document.cookie = "playground-fail=agents=401,invocations=401" // Sign-in on the Agents page
document.cookie = "playground-fail=sections=503"                // The Overview cannot load
document.cookie = "playground-fail=invocation-capabilities=500" // The session filter cannot load
document.cookie = "playground-fail=; max-age=0"                 // Back to the fixtures
```

To share the running playground temporarily, expose the same local server:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

Quick Tunnel URLs are public and have no uptime guarantee. Keep playground data
synthetic.

Auth serves 1,048 synthetic users from `auth-fixture.ts`. It covers Users, profile details, Sessions, Organizations, and Agents, with a plan field, a computed project count, read-only roles, and the OAuth provider's grant revocation limit. Ban, unban, field edits, removal, and session revocation change only this in-memory fixture. Restart the playground to reset it. The real Better Auth fixture is `packages/auth/test/console.test.ts`.

Auth opens on Overview. The fixture has 30 days of sign-ins and sign-ups, sign-in methods, and recent events across all Activity groups. Activity supports subject user IDs and cursor pagination. User panels include their recent events. To check both pages without event storage, restart with `VITEHUB_PLAYGROUND_AUTH_EVENTS=off pnpm exec vp run console:dev`. Database totals remain visible and both pages show the setup snippet. Omit the variable to restore events.
