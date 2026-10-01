---
title: Browser
description: Define provider-backed browser operations without exposing provider setup to application code.
navigation.order: 12.5
navigation.group: Files and execution
icon: i-lucide-monitor
---

Use a Browser Definition when trusted server code needs to inspect a page, render browser-only UI, take a screenshot, or create a PDF. Give each operation a name, then call it from a route, Queue, or Workflow.

Browser Definitions run through Cloudflare Browser Run and require the Cloudflare preset. ViteHub configures the provider, so application code does not import Cloudflare packages or pass browser credentials. Browser works without Agents.

::tip
- **Browser Definition** (`defineBrowser`, `runBrowser`): a named operation with an invocation-owned page session. Use this by default.
- **Browser action** (`runBrowserAction`, `runBrowserContent`): one stateless call, such as content, screenshot, or PDF, with no Definition.
- **Low-level client** (`createBrowser`): you own provider selection, controllers, cleanup, and live handoff.
- **[`browser()` Capability](/docs/capabilities/browser)**: gives a Provider Agent its own `agent-browser` CLI. It does not call this primitive.
::

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add vite-hub
```

### Configure

Enable Browser on the Cloudflare deployment preset.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({
    preset: 'cloudflare',
    browser: true,
  }),
}
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
  return await runBrowser('page-html', input)
})
```

::

The generated Browser registry infers each Definition's input type. `runBrowser()` returns a native `Response`. Discovery and provider failures return a non-2xx JSON `Response`.

## Public imports

| Import | Use |
| --- | --- |
| `defineBrowser`, `runBrowser` from `vite-hub/browser` | Declare and run Browser Definitions. |
| `runBrowserAction`, `runBrowserContent` from `vite-hub/browser/actions` | Run one stateless Browser Run action. |
| `createBrowser` from `vite-hub/browser` | Create a low-level Browser Client. |
| `cloudflareBrowser` from `vite-hub/browser/providers/cloudflare` | Low-level Cloudflare Browser Run provider. |
| `localBrowser` from `vite-hub/browser/providers/local` | Low-level local Chromium provider for trusted Node hosts. |
| `playwright`, `cdp` from `vite-hub/browser/controllers/playwright` and `vite-hub/browser/controllers/cdp` | Attach Playwright or CDP control to a low-level session. |
| `hubBrowser` from `@vite-hub/browser/vite` | Register the Vite Integration without the `vite-hub` distribution. |

Libraries and custom Vite compositions import the same APIs from `@vite-hub/browser` and its subpaths. The package requires Node.js 24.15 or newer.

## Configuration

`browser: true` enables Cloudflare Browser Run actions. Use an object only to change the binding, the session engine, or to connect local development to the hosted service.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

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

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binding` | `string` | `'BROWSER'` | Cloudflare Browser Run binding name. Must be a valid binding identifier. |
| `engine` | `'kitesurf' \| 'chromium'` | `'kitesurf'` | Session engine for `browser.open()`. `'chromium'` selects a persistent Chromium session. |
| `remote` | `boolean` | `false` | Connect local Wrangler development to the hosted Browser Run service. |

`browser: false` disables Browser Provider Output. Without `vite-hub`, pass the same options to `hubBrowser()` from `@vite-hub/browser/vite`.

## Providers

| Path | Provider | Host support |
| --- | --- | --- |
| Browser Definitions and actions | Cloudflare Browser Run | Cloudflare preset only. Other presets throw a configuration error. |
| `createBrowser()` with `cloudflareBrowser()` | Cloudflare Browser Run | Cloudflare Workers with a Browser binding. |
| `createBrowser()` with `localBrowser()` | Local Chromium process | Trusted Node hosts. `browser: true` never selects it. |

The Cloudflare preset writes the Browser Run binding, a default `compatibility_date`, and the `nodejs_compat` flag to the generated `wrangler.json`. Both the root integration and `hubBrowser()` preserve unrelated Wrangler fields.

Cloudflare's Worker `quickAction()` requires remote mode during local development. Set `remote: true` when local Wrangler development must call Browser Run. This uses a Cloudflare account and network access.

Install `@cloudflare/playwright` and `playwright-core` when you set `engine: 'chromium'`. Stateless actions and the default Kitesurf engine do not need these optional peers.

## Definition API

| API | Description |
| --- | --- |
| `defineBrowser(handler)` | Defines one discovered browser operation. The handler receives `(input, { browser })`. |
| `browser.content(input)` | Returns fully rendered HTML as text. |
| `browser.run(action, input)` | Runs a Browser action and returns its standard Web `Response`. |
| `browser.open(options?)` | Opens an invocation-owned page session. The Definition runtime closes it automatically. |
| `session.page.goto(url, options?)` | Navigates the session page and waits for the destination document to load. |
| `session.page.locator(selector, options?)` | Creates a locator with `click()`, `count()`, `fill()`, `inputValue()`, and `waitFor()`. |
| `session.page.press(key)` | Dispatches a keyboard key to the page. |
| `session.inspect()` | Returns the provider-neutral session identifier, state, features, and expiry. |
| `session.close()` | Releases the controller and provider session. Concurrent calls share cleanup. |
| `runBrowser(name, input)` | Runs a discovered Definition with inferred input and returns a native `Response`. |

## Browser actions

Use a Browser action directly when the operation does not need a page session:

```ts [server/render-og.ts]
import { runBrowserContent } from 'vite-hub/browser/actions'

const html = await runBrowserContent('https://example.com')
```

`runBrowserAction(action, input)` returns the raw `Response`. Provider failures return a non-2xx JSON `Response`. `runBrowserContent(input)` reads the `content` action as text and throws when the response is not successful. The input is a URL string or an object with `url` and provider options.

Supported actions: `accessibilityTree`, `content`, `json`, `links`, `markdown`, `pdf`, `scrape`, `screenshot`, and `snapshot`.

Inside a Browser Definition, use `browser.content(input)` or `browser.run(action, input)` for the same actions. The public Definition contract does not expose the provider method.

## Keep a page session open

Use `browser.open()` when one Browser Definition needs several interactions with the same page. ViteHub closes the session after the handler exits. Call `session.close()` to release it sooner.

```ts [server/browsers/page-title.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (input: { url: string }, { browser }) => {
  const session = await browser.open()
  await session.page.goto(input.url)
  await session.page.locator('main').waitFor()
  return await session.page.locator('h1').count()
})
```

Page navigation and pointer clicks run one at a time because either operation can replace the active document. A timeout that leaves page state unclear invalidates the page. Later operations do not reuse that state.

## Low-level sessions

`createBrowser()` is for libraries and standalone integrations that own provider selection, controller attachment, and cleanup. Use it when an application needs Playwright, mutable page state, downloads, or CDP.

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
try {
  const control = await session.attach(playwright())
  try {
    await control.client.page.goto('https://example.com')
  }
  finally {
    await control.release()
  }
}
finally {
  await session.close()
}
```

Install `@cloudflare/playwright` and `playwright-core` when using the Playwright controller on Cloudflare. Cloudflare builds select the `workerd` export condition and exclude the Node Playwright loader. Standalone Worker bundlers must also select `workerd`. The built-in Playwright CDP adapter requires Node.js.

`localBrowser({ executablePath })` from `@vite-hub/browser/providers/local` starts a local Chromium process on a trusted host. It supports CDP control and live handoff. `playwright-core` supplies the controller but does not download a browser. ViteHub does not sandbox the browser process.

## Live handoff

Low-level sessions can transfer one provider session through an opaque reference tied to an audience. The default Kitesurf engine does not support live handoff. Use `engine: 'chromium'` on Cloudflare, or `localBrowser()`.

```ts [server/browser-handoff.ts]
import { createBrowser } from '@vite-hub/browser'
import { cdp } from '@vite-hub/browser/controllers/cdp'
import { cloudflareBrowser } from '@vite-hub/browser/providers/cloudflare'

const browser = createBrowser({
  provider: cloudflareBrowser({ binding: 'BROWSER', engine: 'chromium' }),
})

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

const ref = await (async () => {
  try {
    return await session.handoff({
      audience: 'review-agent-run-42',
      mode: 'live',
    })
  }
  catch (error) {
    await session.close()
    throw error
  }
})()
```

The receiver calls `browser.claim(ref, { audience })` on the same Browser Client. Refs are one-time and do not cross clients or processes. Use the CDP controller when live preservation matters. A Playwright attachment is lifecycle-scoped and cannot be handed off after release.

## Limits

- Browser Definitions and actions require the Cloudflare preset.
- A Browser action waits 30 seconds by default. Timeout fields in the action input extend the wait, up to 6 minutes plus a 30-second grace period.
- The Kitesurf engine has no idle timeout and no live handoff.
- Handoff refs expire after 60 seconds by default. Set `policy.handoffTtl` on `createBrowser()` or pass `ttl` to `session.handoff()`.

## Production checks

Run browser automation only from trusted server code. Browser sessions can observe authenticated pages, cookies, screenshots, network responses, and rendered private UI.

When a request supplies the destination URL, validating only the first URL is not sufficient. Enforce protocol, host, and resolved-address policy for every browser request, including redirects and subresources, or restrict browser egress at the provider. Treat the returned page as untrusted input.

Do not log provider session ids, CDP endpoints, cookies, authorization headers, or raw handoff refs. Treat screenshots and downloaded files as user data. Route them through the same storage, retention, and approval policies as other artifacts.

Inspect the generated `wrangler.json` before deployment, and test the deployed Worker. A successful build proves imports and generated output, not provider availability. Run `vitehub inspect definitions` to list discovered Browser Definitions.

## Connect Browser to Agents

The [`browser()` Capability](/docs/capabilities/browser) gives a Provider Agent the `agent-browser` CLI, Chromium, and the official browser Skill. It runs through the provider's native shell and does not use Browser Definitions. For a model-backed Agent, expose a narrow [custom Capability](/docs/capabilities/custom-capabilities) that calls `runBrowser()`.

## Next steps

- Store screenshots and downloaded files with [Blob](/docs/server-primitives/blob).
- Give Provider Agents a browser with the [Browser capability](/docs/capabilities/browser).
- Deploy Browser Run output on [Cloudflare](/docs/frameworks-hosts/cloudflare).
