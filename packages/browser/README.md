# `@vite-hub/browser`

Browser Definitions for deterministic server-side browser automation.

ViteHub selects the browser provider from the deployment preset. Application code defines a browser operation and opens an invocation-scoped session:

```ts
import { defineBrowser } from "@vite-hub/browser"

export default defineBrowser(async (
  input: {
    url: string
    selector?: string
  },
  { browser },
) => {
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

ViteHub generates the Cloudflare Browser Run binding and uses Kitesurf by default. It closes every session after its Browser Definition completes or throws. `runBrowser()` returns an error-first result, so application code handles runtime failures without a `try/catch`. A definition can open more than one session; each one belongs to that invocation.

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

Live handoff transfers ownership of the exact provider session through an opaque, audience-bound reference. A handed-off session is not automatically closed.
