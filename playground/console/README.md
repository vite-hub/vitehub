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

`channels-fixture.ts` answers the `channels.*` operations. `release-engineer` has simulated Slack and Discord Channels, as `agent.channels.simulate` gives them in `vite dev`, and `product-reviewer` has a real Telegram Channel with a durable State. The simulated Channels serve the real chat page of `@vite-hub/agent` on their webhook route, but no Agent answers a message sent there.

The `Inspect MCP tools and title` session provides synthetic server groups, tool contracts, skipped and empty servers, and a completed Title view for the Capabilities tab.

The `Share one empty state across primitive pages` session is the happy path: a configured Agent, a prepared workspace, reasoning, file reads, commands with output, a file change with diffs, commentary, a Markdown answer, a GitHub reply, and usage with cost. The `Sync docs for the 0.0.5 release` session fails while it prepares the workspace, so the preparation group shows a failed step.

The Agent Invocation records live in `console.fixture.json`. `mock-api.ts` adds
the read-only Usage, KV, Workflow, Queue, and search responses needed by the
Console. `rpc.ts` connects the Console's SSE RPC transport to those local fixture
routes. It also serves a synthetic Connections management API
with three OAuth Connections, one of them with setup docs, one API key Connection, their activity, and one pending approval. Usage filters and pagination use the real usage aggregation code.
Blob, Databases, Email, Rate Limits, Sandboxes, Workspaces, Schedules, Workflows, and Queues answer from synthetic stores, records, and definitions in `mock-api.ts`, so every Console section renders without a provider. Comments answers the `comments.*` operations from three synthetic threads in `comments.ts`, in memory, as a signed-in Maxi who may write, so its rows open the thread panel with replies, resolve, and `@` mentions. A restart resets the threads. Site access answers the `site.*` operations from `site-fixture.ts`: two member browsers, one guest, and one open invite, in memory. The `passkey` Database table has no rows, so it shows the empty table state. The Email outbox uses the real development outbox driver and Console reader. Cache answers the `cache.*` operations with the real operation code over an in-memory `cache` mount in `cache-fixture.ts`, with Nitro 3 keys of cached functions and handlers, one of them expired.
This playground does not change the Console routes generated for Vite
or Nuxt applications.

To check Content loading and Rich/Source editing, start this playground on a fixed port and run the browser regression:

```bash
pnpm exec vp dev --config playground/console/vite.config.ts --host 127.0.0.1 --port 3087
# In another terminal, from the repository root:
CONSOLE_TEST_URL=http://127.0.0.1:3087 node --test packages/vite-hub/test/console-content.browser.mjs
```

The check uses installed Playwright Chromium, the real Console components, and intercepted RPC responses with nine synthetic documents. Saves and publishes change only the fixture in that browser test. It covers delayed and failed loads, retry, empty filters, Rich hydration, mode switching, failed saves and publishes, keyboard controls, and mobile layouts. Set `CONSOLE_TEST_ARTIFACTS` to a project-local directory to save screenshots and element bounds. Stop the dev server when the check ends.

`packages/vite-hub/test/console-empty-states.browser.mjs` uses the same server. It answers some RPC calls with empty results or a failure and checks that the empty and error states of Env, Blob, Email, Workspaces, and KV sit in the middle of their pane, on desktop and narrow screens.

`icons.html` draws every icon name of the Console sources with Nuxt UI's `UIcon` and with the Console `Icon` (`console-icon.vue`). `packages/vite-hub/test/console-icon.browser.mjs` uses the same server and checks that both give the same SVG and the same box:

```bash
CONSOLE_TEST_URL=http://127.0.0.1:3087 node --test packages/vite-hub/test/console-icon.browser.mjs
```

To prove that a change does not move pixels, such as a token rename, capture every Console route on the base and on your branch, and compare the captures:

```bash
pnpm exec vp run --cache -t @vite-hub/auth#build   # and the same for @vite-hub/kit#build and @vite-hub/ui#build, one task per run
node packages/vite-hub/test/console-pixels.browser.mjs capture .cache/console-pixels/base   # on the base commit
node packages/vite-hub/test/console-pixels.browser.mjs capture .cache/console-pixels/head   # on your branch
node packages/vite-hub/test/console-pixels.browser.mjs compare .cache/console-pixels/base .cache/console-pixels/head
```

`capture` reads the routes from the Console router, so a new route is captured without a change to the script. It starts this playground on port 4381 (`--port` changes it), opens each route in light and dark at 1280px and 390px, and stops the playground at the end. The browser and the playground share a fixed clock, so relative times do not change between captures. A route with a required parameter takes its value from a page that opens it, such as `/agents` opening its first session. `manifest.json` lists each shot and each route that has no shot of its own. `compare` prints the share of changed pixels per shot, writes red diff images next to the head folder, and exits with 1 when a shot is missing or changes more than `--threshold` percent (default 0.01). The Console code loads from source. `@vite-hub/ui/theme.css` loads from `packages/ui/dist`, so run `pnpm exec vp run -t @vite-hub/ui#build` on each side when the change is in that file. A shot shows each page as it opens. Panels, menus, and states that need a click are not captured.

CI runs the same check on a pull request that changes `packages/vite-hub/src/console/`, this playground, `packages/kit/src/styles/`, `packages/ui/theme.css`, or the oracle. The `console pixels` job captures the base branch and the pull request in one job and compares them. When a shot changes, it fails and uploads the `console-pixels` artifact with both captures and the diff images. When the pull request changes pixels on purpose, add the `console-pixels:expected` label, run the job again, and explain each changed shot in the pull request.

To see an error state, set the `playground-fail` cookie to `<route>=<status>` pairs. A route is the path after
`/_vitehub/api/`, and it also matches the paths under it:

```js
document.cookie = "playground-fail=agents=401,invocations=401" // Sign-in on the Agents page
document.cookie = "playground-fail=sections=503"                // The Overview cannot load
document.cookie = "playground-fail=invocation-capabilities=500" // The session filter cannot load
document.cookie = "playground-fail=; max-age=0"                 // Back to the fixtures
```

To see the Console of a smaller app, set the `playground-sections` cookie to the section ids to keep. The other sections show up in "Add a primitive":

```js
document.cookie = "playground-sections=comments,databases,env"
document.cookie = "playground-sections=; max-age=0"             // Every section again
```

To share the running playground temporarily, expose the same local server:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

Quick Tunnel URLs are public and have no uptime guarantee. Keep playground data
synthetic.

The MCP client section answers from `mcp-client-fixture.ts`, which keeps its connections in the playground process. Northwind Ledger, the app's own `/mcp`, has Maxi and Lucía through OAuth, Lucía's API key, and Sam, who is signed out. `docs.example.com/mcp` needs no sign-in. Run `get_finances` with the `household` scope as Maxi and Lucía to compare their accounts. **Connect** with OAuth goes through the real callback page, and **Sign in as someone else** finishes as Sam. Restart the playground to reset the connections.

Auth serves 1,048 synthetic users from `auth-fixture.ts`. It covers Users, profile details, Sessions, Organizations, and Agents, with a plan field, a computed project count, read-only roles, and the OAuth provider's grant revocation limit. Ban, unban, field edits, removal, and session revocation change only this in-memory fixture. Impersonate is on: start it from a non-admin user, and the playground root returns to the Console, where the Auth section shows the banner and **Stop impersonating**. Admins and the banned user show Better Auth's refusal. Restart the playground to reset it. The real Better Auth fixture is `packages/auth/test/console.test.ts`.

Auth opens on Overview. The fixture has 30 days of sign-ins and sign-ups, sign-in methods, and recent events across all Activity groups. Activity supports subject user IDs and cursor pagination. User panels include their recent events. To check both pages without event storage, restart with `VITEHUB_PLAYGROUND_AUTH_EVENTS=off pnpm exec vp run console:dev`. Database totals remain visible and both pages show the setup snippet. Omit the variable to restore events.

## Move a part to ui-sdk

The Console moves from Nuxt UI to ui-sdk one part or one page at a time. `client/styles.css` already loads `@vite-hub/kit/styles/default.scoped.css`, the kit style family under `:where(.ui-sdk)`, so its rules style only the elements inside an element with the `ui-sdk` class. A page PR moves a part in three steps:

1. Wrap the part in a scope root: put `class="ui-sdk"` on its own element, or on a `<div>` around it. The root holds the part and nothing else from Nuxt UI.
2. Swap the tags inside the root: `@ui-sdk/vue` parts for `<U*>` components, and the kit's CSS-only parts (`data-slot="vh-badge"`, `vh-empty`, `vh-skeleton`, ...) for UBadge, UEmpty, and USkeleton. See the README of `@vite-hub/kit`. Keep the Tailwind classes: the kit Tailwind bridge keeps `text-muted`, `bg-elevated`, and the other semantic utilities.
3. Run the oracle on the base and on your branch, as described above. `capture` fails a shot when a scope root holds a Nuxt UI component, and names the component. Explain every changed shot in the PR, with before and after images.

The Console theme supplies the kit foreground, input, overlay, and popup tokens as well as the shared palette. Check a scoped solid button, input, and popup with the actual Console imports: `pnpm --dir packages/ui exec node --test test/browser/console-scope.browser.mjs`. This check needs Playwright Chromium.

A scope root holds no Nuxt UI component: inside it, the kit rules on `[data-slot]` apply, and 8 slot names, such as `button` and `label`, are the same in Nuxt UI and ui-sdk. A Nuxt UI component around a root, such as a card with a root in its slot, is fine. Nuxt UI menus and dialogs teleport to `<body>`, outside every root. `client/styles.css` declares the layer order `theme, base, kit, components, utilities` before its imports and loads the scoped family in `kit`, so the kit rules beat Preflight and Tailwind utility classes beat the kit rules. The family cannot stay in a top-level `ui-sdk` layer: ui-sdk puts a `<style>` with that layer first in `<head>` when a part such as the toaster mounts, so `ui-sdk` is always the first layer, below Preflight.
