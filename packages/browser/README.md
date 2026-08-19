# `@vite-hub/browser`

Browser Definitions and Browser Run quick actions for deterministic server-side browser automation.

Use Browser Run quick actions when the operation fits Cloudflare's hosted action surface:

```ts
import { runBrowserContent } from "@vite-hub/browser/actions"

const [error, html] = await runBrowserContent("https://example.com")
if (error) throw error
```

Application code can also define a browser operation. It can use quick actions without opening a session, or call `browser.open()` when it needs Playwright:

```ts
import { defineBrowser } from "@vite-hub/browser"

export default defineBrowser(async (
  input: {
    url: string
    selector?: string
  },
  { browser },
) => {
  if (!input.selector) return await browser.content(input.url)

  const session = await browser.open()
  await session.page.goto(input.url)
  return await session.page.locator(input.selector ?? "body").screenshot({
    type: "png",
  })
})
```

Place definitions in `server/browsers/` or name them `*.browser.ts`, then run them by name:

```ts
import { runBrowser } from "@vite-hub/browser"

const [error, image] = await runBrowser("code-image", {
  url: "https://example.com",
})
if (error) throw error
```

Enable Browser through the ViteHub deployment:

```ts
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      preset: "cloudflare",
      browser: true,
    }),
  ],
})
```

ViteHub generates the Cloudflare Browser Run binding and uses quick actions without Playwright. Apps that call `browser.open()` install `@cloudflare/playwright` and `playwright-core`; quick-action-only apps do not. ViteHub closes every opened session after its Browser Definition completes or throws. `runBrowser()` returns an error-first result, so application code handles runtime failures without a `try/catch`. A definition can open more than one session; each one belongs to that invocation.

Kitesurf uses Cloudflare's service-defined session timeout and rejects `idleTimeoutMs`. Select `engine: "chromium"` when an invocation must configure a persistent session's idle timeout.

## Low-level sessions

`createBrowser()` remains available for standalone integrations where the caller owns provider selection and cleanup. Controller attachment is imperative:

```ts
const session = await browser.open()
const control = await session.attach(controller)

try {
  await control.client.doSomething()
}
finally {
  await control.release()
  await session.close()
}
```

Live handoff transfers ownership of the exact provider session through an opaque, audience-bound reference. Cloudflare's Kitesurf default is sessionless, so select `engine: "chromium"` when live handoff is required. A handed-off session is not automatically closed.
