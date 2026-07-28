---
title: Browser
description: Define provider-backed browser operations without exposing provider setup to application code.
navigation.order: 13
icon: i-lucide-monitor
---

Browser Definitions are named, server-side browser operations. Use them when a route, job, workflow, or trusted server actor needs to inspect a page, render browser-only UI, or capture evidence.

ViteHub discovers each definition, selects the provider from the deployment preset, and owns every session opened during the invocation. Application code does not import a Cloudflare provider or pass browser credentials.

Browser is a server primitive, not an Agent Capability. Server code invokes Browser Definitions directly. Agents receive browser access only when you expose an appropriate tool or attach a model-facing Capability such as [`browser()`](/docs/capabilities/browser).

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub @cloudflare/playwright playwright-core
```

### Configure

Enable Browser on the Cloudflare deployment preset.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      browser: true,
    }),
  ],
})
```

### Define a browser operation

Place Browser Definitions in `server/browsers/` or name them `*.browser.ts`.

```ts [server/browsers/page-title.ts]
import { defineBrowser, useBrowserSession } from 'vite-hub/browser'

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  const session = await useBrowserSession(browser)
  await session.page.goto(input.url)
  return await session.page.title()
})
```

### Run it by name

```ts [server/api/page-title.post.ts]
import { runBrowser } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ url: string }>(event)
  return await runBrowser('page-title', input)
})
```

::

The generated Browser registry infers each definition's input and result types. ViteHub closes every session after the definition completes or throws, including when one invocation opens several sessions.

## Runtime API

| API | Description |
| --- | --- |
| `defineBrowser(handler)` | Defines one discovered browser operation. |
| `useBrowserSession(browser, options?)` | Opens a Playwright-backed session owned by the current definition invocation. |
| `runBrowser(name, input)` | Runs a discovered definition with inferred input and result types. |
| `session.browser` | Playwright Browser connected to the provider session. |
| `session.context` | Invocation-owned Playwright Browser Context. |
| `session.page` | Initial Playwright Page. |
| `session.inspect()` | Returns sanitized session state without provider credentials. |
| `session.close()` | Closes a session early; otherwise the definition runner closes it. |

## Configuration

`browser: true` enables Browser with the deployment preset's defaults. Use an object only when the host binding name must change.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      browser: {
        binding: 'RENDER_BROWSER',
      },
    }),
  ],
})
```

| Shape | Description |
| --- | --- |
| `browser: true` | Enables Browser with the `BROWSER` binding. |
| `browser: { binding }` | Enables Browser with a custom Cloudflare binding name. |
| `browser: false` | Disables Browser Provider Output. |

The Cloudflare preset writes the Browser Run binding and `nodejs_compat` flag to generated Provider Output. Inspect the generated `wrangler.json` before deployment when runtime bindings change.

## Low-level sessions

`createBrowser()` remains available for libraries and standalone integrations that deliberately own provider selection, controller attachment, and cleanup.

```ts [server/browser.ts]
import { createBrowser } from '@vite-hub/browser'
import { playwright } from '@vite-hub/browser/controllers/playwright'
import { cloudflareBrowser } from '@vite-hub/browser/providers/cloudflare'

const browser = createBrowser({
  provider: cloudflareBrowser({ binding: 'BROWSER' }),
})

const session = await browser.open()
const control = await session.attach(playwright())

try {
  await control.client.page.goto('https://example.com')
}
finally {
  await control.release()
  await session.close()
}
```

Provider and controller subpaths are advanced integration surfaces. Normal ViteHub application code should use Browser Definitions so the deployment preset can own the provider.

## Live handoff

Low-level sessions can transfer ownership of an exact provider session through an opaque, audience-bound reference.

```ts [server/browser-handoff.ts]
import { cdp } from '@vite-hub/browser/controllers/cdp'

const session = await browser.open()
const control = await session.attach(cdp())

try {
  await control.client.send('Target.createTarget', {
    url: 'https://example.com',
  })
}
finally {
  await control.release()
}

const ref = await session.handoff({
  audience: 'review-agent-run-42',
  mode: 'live',
})
```

Refs are one-time, short-lived, and scoped to the Browser Client that created them. Use the CDP controller when live preservation matters; Playwright attachment is lifecycle-scoped and cannot be handed off after release.

## Production boundaries

Keep browser automation behind trusted server boundaries. Browser sessions can observe authenticated pages, cookies, screenshots, network responses, and rendered private UI.

Do not log provider session ids, CDP endpoints, cookies, authorization headers, or raw handoff refs. Treat screenshots and downloaded files as user data and route them through the same storage, retention, and approval policies as other artifacts.

## Next steps

- Store screenshots and downloaded files with [Blob](/docs/server-primitives/blob).
- Expose model-facing browser access through [Browser capability](/docs/capabilities/browser).
- Deploy Browser Run output on [Cloudflare](/docs/frameworks-hosts/cloudflare).
