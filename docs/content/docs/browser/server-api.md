---
title: Browser server API
description: Define, run, and control browser operations from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Browser Definitions are the default path. Use Browser actions for one stateless call, and low-level sessions when your code owns the provider and cleanup.

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

If reading the controller client or attachment tracing fails, ViteHub releases the controller before rejecting `session.attach()`. If controller cleanup also fails, the session blocks another attachment or handoff. Call `session.close()` to retry failed rollback cleanup before terminating the provider session. Closure waits for pending controller rollback cleanup before terminating the provider; if it fails again, closure rejects and can be retried. Detach tracing does not delay provider termination after controller cleanup succeeds.

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
