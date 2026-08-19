# `@vite-hub/browser`

Browser Definitions and provider-backed actions for deterministic server-side browser automation.

Use an action directly when the operation does not need a persistent session:

```ts
import { runBrowserContent } from "@vite-hub/browser/actions"

const [error, html] = await runBrowserContent("https://example.com")
if (error) throw error
```

Application code can also define a named browser operation without exposing its provider:

```ts
import { defineBrowser } from "@vite-hub/browser"

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  return await browser.content(input.url)
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

ViteHub generates the Cloudflare Browser Run binding and maps the provider's `quickAction()` method to ViteHub's `browser.run()` and `browser.content()` API. `runBrowser()` returns an error-first result, so application code handles runtime failures without a `try/catch`.

## Low-level sessions

`createBrowser()` remains available for standalone integrations where the caller explicitly owns provider selection, controller selection, and cleanup. Playwright stays on this path instead of being selected implicitly by a Browser Definition:

```ts
import { createBrowser } from "@vite-hub/browser"
import { playwright } from "@vite-hub/browser/controllers/playwright"
import { cloudflareBrowser } from "@vite-hub/browser/providers/cloudflare"

const browser = createBrowser({ provider: cloudflareBrowser() })
const session = await browser.open()
const control = await session.attach(playwright())

try {
  await control.client.doSomething()
}
finally {
  await control.release()
  await session.close()
}
```

Live handoff transfers ownership of the exact provider session through an opaque, audience-bound reference. Cloudflare's Kitesurf default is sessionless, so select `engine: "chromium"` when live handoff is required. A handed-off session is not automatically closed.
