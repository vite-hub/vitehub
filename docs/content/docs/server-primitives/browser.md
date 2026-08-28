---
title: Browser
description: Define provider-backed browser operations without exposing provider setup to application code.
navigation.order: 12.5
navigation.group: Files and execution
icon: i-lucide-monitor
---

Use a Browser Definition when trusted server code needs to inspect a page, render browser-only UI, take a screenshot, or create a PDF. Give each operation a name, then call it from a route, queue, or workflow.

Browser Definitions currently run through Cloudflare Browser Run and require the Cloudflare preset. ViteHub configures the provider, so application code doesn't import Cloudflare packages or pass browser credentials.

Server code calls Browser Definitions directly. To give an Agent browser access, attach the [`browser()` Capability](/docs/capabilities/browser) or expose a narrower tool.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub
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

```ts [server/browsers/page-html.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  return await browser.content(input.url)
})
```

### Run it by name

```ts [server/api/page-html.post.ts]
import { runBrowser } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ url: string }>(event)
  const [error, html] = await runBrowser('page-html', input)
  if (error) throw error
  return html
})
```

::

The generated Browser registry infers each definition's input and result types. `runBrowser()` returns an error-first tuple.

## Runtime API

| API | Description |
| --- | --- |
| `defineBrowser(handler)` | Defines one discovered browser operation. |
| `browser.content(input)` | Returns fully rendered HTML as text. |
| `browser.run(action, input)` | Runs a browser action and returns its standard Web `Response`. |
| `browser.open(options?)` | Opens an invocation-owned page session. The definition runtime closes it automatically. |
| `session.page.goto(url, options?)` | Navigates the session page and waits for the destination document to load. |
| `session.page.locator(selector, options?)` | Creates a locator with `click()`, `count()`, `fill()`, `inputValue()`, and `waitFor()`. |
| `session.page.press(key)` | Dispatches a keyboard key to the page. |
| `session.inspect()` | Returns the provider-neutral session identifier, state, features, and expiry. |
| `session.close()` | Releases the controller and provider session; concurrent calls share cleanup. |
| `runBrowser(name, input)` | Runs a discovered definition and returns `[error, result]` with inferred types. |

## Configuration

`browser: true` enables Cloudflare Browser Run actions. Use an object only to change the host binding or connect local development to the hosted service.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      browser: {
        binding: 'RENDER_BROWSER',
        remote: true,
      },
    }),
  ],
})
```

| Shape | Description |
| --- | --- |
| `browser: true` | Enables Browser Run with the `BROWSER` binding. |
| `browser: { binding?, engine?, remote? }` | Customizes the Cloudflare binding; `engine: 'chromium'` selects a persistent Chromium session, and `remote: true` connects local Wrangler development to Browser Run. |
| `browser: false` | Disables Browser Provider Output. |

The Cloudflare preset writes the Browser Run binding, a compatible default `compatibility_date`, and the `nodejs_compat` flag to Nitro's generated Provider Output.

Cloudflare's Worker `quickAction()` currently requires remote mode during local development. Set `remote: true` when local Wrangler development must call Browser Run. Both the root integration and direct `hubBrowser()` output write the Browser binding and required compatibility fields while preserving unrelated Wrangler fields.

Install `@cloudflare/playwright` and `playwright-core` when `browser.open()` uses `engine: 'chromium'`. Stateless Browser actions and the default Kitesurf session path do not require those optional peers.

## Browser actions

Use a Browser action directly when the operation does not need a persistent session:

```ts [server/render-og.ts]
import { runBrowserContent } from 'vite-hub/browser/actions'

const [error, html] = await runBrowserContent('https://example.com')
if (error) throw error
```

`runBrowserAction(action, input)` returns the raw `Response` for binary actions such as screenshots or PDFs. `runBrowserContent(input)` reads the `content` action response as text. Cloudflare's `quickAction()` name stays inside the provider adapter.

Browser Definitions can use the same path through the definition context:

```ts [server/browsers/page-html.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (input: { url: string }, { browser }) => {
  return await browser.content(input.url)
})
```

Use `browser.run(action, input)` for other actions. The current ViteHub action backend is Cloudflare Browser Run; the public Definition contract does not expose the provider method.

## Keep a page session open

Use `browser.open()` when one Browser Definition needs several interactions with the same page. ViteHub closes the session after the handler exits. Call `session.close()` when you can release it sooner.

```ts [server/browsers/page-title.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (input: { url: string }, { browser }) => {
  const session = await browser.open()
  await session.page.goto(input.url)
  await session.page.locator('main').waitFor()
  return await session.page.locator('h1').count()
})
```

Page navigation and pointer clicks are serialized because either operation can replace the active document. Timeouts that leave page state ambiguous invalidate the page instead of allowing later operations to reuse uncertain state.

## Low-level sessions

`createBrowser()` remains available for libraries and standalone integrations that deliberately own provider selection, controller attachment, and cleanup.

Install the owner package before importing its low-level providers and
controllers:

```bash [Terminal]
pnpm add @vite-hub/browser
```

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
  try {
    await control.release()
  }
  finally {
    await session.close()
  }
}
```

Provider and controller subpaths are for low-level integrations. Use them when an application needs Playwright, mutable page state, downloads, or CDP instead of stateless actions. Install `@cloudflare/playwright` and `playwright-core` when using the Cloudflare Playwright controller.

`localBrowser({ executablePath })` from `@vite-hub/browser/providers/local` starts a local Chromium process for trusted-host development. It supports CDP control and live handoff, but ViteHub doesn't select it through `browser: true`. Pass it to `createBrowser()` when the application manages the browser process itself.

## Live handoff

Low-level sessions can transfer one provider session through an opaque reference tied to an audience. Cloudflare's Kitesurf default is sessionless and doesn't support live handoff. Select `engine: 'chromium'` when a handoff must preserve the session.

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

## Production checks

Run browser automation only from trusted server code. Browser sessions can observe authenticated pages, cookies, screenshots, network responses, and rendered private UI.

Do not log provider session ids, CDP endpoints, cookies, authorization headers, or raw handoff refs. Treat screenshots and downloaded files as user data and route them through the same storage, retention, and approval policies as other artifacts.

## Next steps

- Store screenshots and downloaded files with [Blob](/docs/server-primitives/blob).
- Expose model-facing browser access through [Browser capability](/docs/capabilities/browser).
- Deploy Browser Run output on [Cloudflare](/docs/frameworks-hosts/cloudflare).
