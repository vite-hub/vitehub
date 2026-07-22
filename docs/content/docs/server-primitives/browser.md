---
title: Browser
description: Open provider-backed browser sessions from server code without exposing provider credentials or browser internals.
navigation.order: 13
icon: i-lucide-monitor
---

Browser opens provider-backed browser sessions for deterministic server code.
Use it when a route, job, workflow, or trusted server actor needs to inspect a page, render browser-only UI, capture evidence, or transfer a live browser session to another trusted step.

Browser is a server primitive, not an Agent Capability. Server code calls the Browser Runtime Helper directly. Agents receive browser access only when you attach a model-facing Capability such as [`browser()`](/docs/capabilities/browser).

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/browser @cloudflare/playwright
```

### Configure

For Cloudflare Browser Run Provider Output, register `hubBrowser()`.

```ts [vite.config.ts]
import { hubBrowser } from '@vite-hub/browser/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubBrowser()],
})
```

### Start using it

```ts [server/api/page-title.get.ts]
import { createBrowser } from '@vite-hub/browser'
import { playwright } from '@vite-hub/browser/controllers/playwright'
import { cloudflareBrowser } from '@vite-hub/browser/providers/cloudflare'

const browser = createBrowser({
  provider: cloudflareBrowser({ binding: 'BROWSER' }),
})

export default defineEventHandler(async () => {
  return browser.withSession(session =>
    session.use(playwright(), async ({ page }) => {
      await page.goto('https://example.com')
      return { title: await page.title() }
    }),
  )
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `createBrowser` from `@vite-hub/browser` | Create a Browser Client for a selected provider. |
| `cdp` from `@vite-hub/browser/controllers/cdp` | Attach a raw Chrome DevTools Protocol controller that can preserve live handoff. |
| `playwright` from `@vite-hub/browser/controllers/playwright` | Attach a Playwright controller for lifecycle-scoped browser work. |
| `cloudflareBrowser` from `@vite-hub/browser/providers/cloudflare` | Use Cloudflare Browser Run through a Workers Browser binding. |
| `localBrowser` from `@vite-hub/browser/providers/local` | Launch local Chromium with an isolated temporary profile. |
| `hubBrowser` from `@vite-hub/browser/vite` | Register Cloudflare Browser Run Provider Output. |

Browser session, provider, controller, policy, and error types are exported from `@vite-hub/browser`.

## Configuration options

Configure Browser through the Browser Client, provider options, and optional Vite Integration options.

```ts [server/browser.ts]
import { createBrowser } from '@vite-hub/browser'
import { cloudflareBrowser } from '@vite-hub/browser/providers/cloudflare'

export const browser = createBrowser({
  provider: cloudflareBrowser({ binding: 'BROWSER' }),
  policy: {
    handoffTtl: 30_000,
    idleTimeoutMs: 60_000,
  },
})
```

| Shape | Description |
| --- | --- |
| `createBrowser({ provider })` | Creates a Browser Client using one provider boundary. |
| `policy.handoffTtl` | Default lifetime for one-time Browser Session refs. |
| `policy.idleTimeoutMs` | Default provider lease TTL passed when opening sessions. |
| `leaseStore` | Optional runtime lease store for limiting provider session ownership. |
| `trace` | Optional lifecycle trace sink. Trace events use sanitized Browser Session ids, not provider secrets. |
| `hubBrowser({ binding })` | Writes a Cloudflare Browser Run binding. Default: `BROWSER`. |
| `browser: false` | Disables Browser Provider Output when using a composed ViteHub config. |

## Providers

| Provider | Import | Use it when |
| --- | --- | --- |
| Cloudflare Browser Run | `@vite-hub/browser/providers/cloudflare` | Production or preview Workers should use Cloudflare's managed Browser binding. |
| Local Chromium | `@vite-hub/browser/providers/local` | Local tests or trusted-host automation should launch a specific Chromium executable. |

The provider owns session creation and cleanup. Application code should not depend on provider session ids, CDP endpoints, cookies, or Worker binding internals.

## Use it at runtime

Use `withSession()` when the session should be closed after one scoped operation.

```ts [server/render-title.ts]
import { playwright } from '@vite-hub/browser/controllers/playwright'
import { browser } from './browser'

export async function renderTitle(url: string) {
  return browser.withSession(session =>
    session.use(playwright(), async ({ page }) => {
      await page.goto(url)
      return page.title()
    }),
  )
}
```

Use `open()` when the caller must inspect, hand off, or close the session explicitly.

```ts [server/browser-session.ts]
import { browser } from './browser'

const session = await browser.open()

try {
  return session.inspect()
}
finally {
  await session.close()
}
```

## Runtime Helper

`createBrowser()` returns a Browser Client.

| Method | Description |
| --- | --- |
| `browser.open(options?)` | Opens one provider session and returns a Browser Session. |
| `browser.withSession(run, options?)` | Opens a session, runs scoped work, and closes the session unless ownership was handed off. |
| `browser.claim(ref, { audience })` | Claims a one-time Browser Session ref for the intended audience. |
| `session.use(controller, run)` | Attaches one controller to the session and releases it after the callback. |
| `session.handoff({ audience, mode: 'live', ttl? })` | Creates a one-time live handoff ref when the provider and controller support live reattachment. |
| `session.inspect()` | Returns sanitized session id, provider, state, features, and expiry. |
| `session.close()` | Closes the provider session and releases its lease. |

## Live handoff

Live handoff transfers ownership of the exact provider session. It does not export cookies, a CDP endpoint, provider credentials, or reconstructed state.

```ts [server/browser-handoff.ts]
import { cdp } from '@vite-hub/browser/controllers/cdp'
import { browser } from './browser'

const session = await browser.open()

await session.use(cdp(), async (client) => {
  await client.send('Target.createTarget', { url: 'https://example.com' })
})

const ref = await session.handoff({
  audience: 'review-agent-run-42',
  mode: 'live',
})

const claimed = await browser.claim(ref, {
  audience: 'review-agent-run-42',
})
```

Refs are one-time, short-lived, and scoped to the Browser Client that created them.
Cross-process or durable handoff requires a future runtime-backed handoff store.

Use the CDP controller when live session preservation matters. The Playwright controller is lifecycle-scoped; live handoff after Playwright use is rejected because closing Playwright can terminate or reset provider browser state.

## Provider output

`hubBrowser()` writes Cloudflare Browser Run configuration to generated Provider Output. In Nitro-backed builds it also merges the required `nodejs_compat` Worker compatibility flag. Other Vite builds must add `nodejs_compat` to their app-owned Wrangler configuration.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [
    hubBrowser({ binding: 'BROWSER' }),
  ],
})
```

On Cloudflare, inspect the generated `wrangler.json` and verify both the `browser` binding and `nodejs_compat` before deployment.

## Connect it to Agents

Direct Browser access is for trusted server code. To give a model browser access during an Agent Invocation, attach the [`browser()` Capability](/docs/capabilities/browser).

The current `browser()` Capability exposes an `agent-browser` command through the global `bash` tool and contributes a Workspace skill file. It does not claim or share `@vite-hub/browser` sessions.

Cloudflare Browser Run plus stock `agent-browser` is not documented as a live handoff pair. Cloudflare requires authenticated WebSocket headers that the public `agent-browser --cdp` interface cannot currently supply without a credential-aware proxy or provider-specific command wrapper.

## Production boundaries

Keep browser automation behind trusted server boundaries. Browser sessions can observe authenticated pages, cookies, screenshots, network responses, and rendered private UI.

Do not log provider session ids, CDP endpoints, cookies, authorization headers, or raw handoff refs. Treat screenshots and downloaded files as user data and route them through the same storage, retention, and approval policies as other artifacts.

Close sessions explicitly when not using `withSession()`. Provider-managed browsers can outlive the request that opened them until the provider expires or terminates the session.

## Next steps

- Expose model-facing browser evidence through [Browser capability](/docs/capabilities/browser).
- Store screenshots and downloaded files with [Blob](/docs/server-primitives/blob).
- Run isolated browser-adjacent commands with [Sandbox](/docs/server-primitives/sandbox).
- Deploy Browser Run output on [Cloudflare](/docs/frameworks-hosts/cloudflare).
