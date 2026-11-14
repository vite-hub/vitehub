---
title: Browser server API
description: Define and run browser work from server code, keep a page session open, and hand off a live session.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Start with Browser Definitions, one file per browser task. Use Browser actions for one stateless call, and low-level sessions to own the provider and cleanup.

## Public imports

| Import | Use |
| --- | --- |
| `defineBrowser`, `runBrowser` from `vite-hub/browser` | Declare and run Browser Definitions. |
| `runBrowserAction`, `runBrowserContent` from `vite-hub/browser` | Run one stateless Browser Run action. |
| `isBrowserAvailable` from `vite-hub/browser` | Check whether this build enables Browser. See [Builds without Browser](/docs/browser/hosts#builds-without-browser). |
| `createBrowser` from `vite-hub/browser` | Create a low-level Browser Client. |
| `cloudflareBrowser` from `vite-hub/browser/providers/cloudflare` | Low-level Cloudflare Browser Run provider. |
| `localBrowser` from `vite-hub/browser/providers/local` | Low-level local Chromium provider for trusted Node hosts. |
| `playwright`, `cdp` from `vite-hub/browser/controllers/playwright` and `vite-hub/browser/controllers/cdp` | Attach Playwright or CDP to a low-level session. |
| `hubBrowser` from `@vite-hub/browser/vite` | Add the Vite plugin without the `vite-hub` package. |

Libraries and custom Vite setups import the same APIs from `@vite-hub/browser` and its subpaths. The package needs Node.js 22.18 or newer.

## Definition API

| API | Description |
| --- | --- |
| `defineBrowser(handler)` | Defines one browser task. The handler gets `(input, { browser })`. |
| `browser.content(input)` | Returns the rendered HTML as text. |
| `browser.run(action, input)` | Runs a Browser action and returns its `Response`. |
| `browser.open(options?)` | Opens a page session for this run. ViteHub closes it for you. |
| `session.page.goto(url, options?)` | Goes to a URL and waits for the page to load. |
| `session.page.locator(selector, options?)` | Creates a locator with `click()`, `count()`, `fill()`, `inputValue()`, and `waitFor()`. |
| `session.page.press(key)` | Presses a keyboard key on the page. |
| `session.inspect()` | Returns the session id, state, features, and expiry, the same on every provider. |
| `session.close()` | Releases the controller and provider session. Parallel calls share one cleanup. |
| `runBrowser(name, input)` | Runs a Definition with typed input and returns a native `Response`. |

## Browser actions

Call a Browser action directly when you do not need a page session:

```ts [server/render-og.ts]
import { runBrowserContent } from 'vite-hub/browser'

const html = await runBrowserContent('https://example.com')
```

`runBrowserAction(action, input)` returns the raw `Response`. Provider failures return a non-2xx JSON `Response`. `runBrowserContent(input)` returns the `content` action as text and throws on failure. The input is a URL string or an object with `url` and provider options.

Supported actions: `accessibilityTree`, `content`, `json`, `links`, `markdown`, `pdf`, `scrape`, `screenshot`, and `snapshot`.

In a Browser Definition, use `browser.content(input)` or `browser.run(action, input)` for the same actions. Definitions do not expose the provider method.

## Keep a page session open

Use `browser.open()` to do several things on one page. ViteHub closes the session when the handler ends. Call `session.close()` to close it sooner.

```ts [server/browsers/page-title.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (input: { url: string }, { browser }) => {
  const session = await browser.open()
  await session.page.goto(input.url)
  await session.page.locator('main').waitFor()
  return await session.page.locator('h1').count()
})
```

Navigation and clicks run one at a time, because each can replace the page. A timeout that leaves the page state unclear makes the page invalid, and later calls do not reuse it.

## Low-level sessions

`createBrowser()` is for libraries and standalone code that choose the provider, attach the controller, and clean up. Use it when you need Playwright, page state that changes, downloads, or CDP.

```bash [Terminal]
pnpm add @vite-hub/browser
```

```ts [server/browser.ts]
import { createBrowser } from 'vite-hub/browser'
import { playwright } from 'vite-hub/browser/controllers/playwright'
import { cloudflareBrowser } from 'vite-hub/browser/providers/cloudflare'

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

If reading the controller client or attach tracing fails, ViteHub releases the controller before `session.attach()` rejects. If that cleanup fails too, the session blocks another attach or handoff. `session.close()` retries the cleanup before it ends the provider session. If cleanup fails again, close rejects and you can retry. Detach tracing does not delay shutdown after cleanup succeeds.

For the Playwright controller on Cloudflare, install `@cloudflare/playwright` and `playwright-core`. Cloudflare builds use the `workerd` export condition and leave out the Node Playwright loader. Standalone Worker bundlers must also use `workerd`. The built-in Playwright CDP adapter needs Node.js.

`localBrowser({ executablePath })` from `vite-hub/browser/providers/local` starts local Chromium on a trusted host. It supports CDP and live handoff. `playwright-core` supplies the controller but no browser. ViteHub does not sandbox this process. It rejects `idleTimeoutMs`, from `open()` or `policy`, because nothing closes an idle local Chromium. Call `session.close()` when you are done.

## Live handoff

A low-level session can pass its provider session to other code through an opaque ref tied to an audience. The default Kitesurf engine cannot do this. Use `engine: 'chromium'` on Cloudflare, or `localBrowser()`.

```ts [server/browser-handoff.ts]
import { createBrowser } from 'vite-hub/browser'
import { cdp } from 'vite-hub/browser/controllers/cdp'
import { cloudflareBrowser } from 'vite-hub/browser/providers/cloudflare'

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

The receiver calls `browser.claim(ref, { audience })` on the same Browser Client. A ref works once and only in that client and process. Use the CDP controller to keep the live page. A Playwright attachment cannot be handed off after it is released.
