# `@vite-hub/browser`

Provider-agnostic Browser Sessions for deterministic server code.

```ts
import { createBrowser } from "@vite-hub/browser"
import { playwright } from "@vite-hub/browser/controllers/playwright"
import { localBrowser } from "@vite-hub/browser/providers/local"

const browser = createBrowser({
  provider: localBrowser({ executablePath: process.env.CHROME_PATH! }),
})

const title = await browser.withSession(session =>
  session.use(playwright(), async ({ page }) => {
    await page.goto("https://example.com")
    return await page.title()
  }),
)
```

## Live handoff

```ts
import { cdp } from "@vite-hub/browser/controllers/cdp"
```

A handoff transfers ownership of the exact provider session. It never exports cookies, a CDP endpoint, provider credentials, or reconstructed state.

```ts
const session = await browser.open()

await session.use(cdp(), async (client) => {
  await preparePageWithCDP(client)
})

const ref = await session.handoff({
  audience: "review-agent-run-42",
  mode: "live",
})

const claimed = await browser.claim(ref, { audience: "review-agent-run-42" })
```

References are one-time, short-lived, and scoped to the `BrowserClient` that created them. Cross-process or durable handoff requires a future runtime-backed handoff store; the in-process contract does not pretend otherwise.

The bundled CDP controller certifies live handoff by closing only its transport on release. The Playwright controller is lifecycle-only because Playwright close terminates or resets CDP browser state across the supported providers; live handoff after Playwright use is rejected explicitly.

Live handoff is rejected when the provider, receiving controller, or releasing controller cannot preserve and reattach to the existing session. State reconstruction is intentionally not a fallback.

## Cloudflare Browser Run

```ts
import { createBrowser } from "@vite-hub/browser"
import { playwright } from "@vite-hub/browser/controllers/playwright"
import { cloudflareBrowser } from "@vite-hub/browser/providers/cloudflare"

const browser = createBrowser({
  provider: cloudflareBrowser({ binding: "BROWSER" }),
})

await browser.withSession(session =>
  session.use(playwright(), async ({ page }) => {
    await page.goto("https://example.com")
  }),
)
```

Configure Provider Output with `hubBrowser()`:

```ts
import { defineConfig } from "vite"
import { hubBrowser } from "@vite-hub/browser/vite"

export default defineConfig({
  plugins: [hubBrowser()],
})
```

Cloudflare Browser Run plus stock `agent-browser` is not advertised as a live pair. Cloudflare requires authenticated WebSocket headers that the current public `agent-browser --cdp` interface cannot supply without exposing or proxying credentials.
