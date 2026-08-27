# `@vite-hub/browser`

`@vite-hub/browser` runs trusted server-side browser work through named Browser Definitions, stateless actions, or caller-managed sessions.

Browser Definitions and actions currently use Cloudflare Browser Run. Low-level clients can instead start a local Chromium process on a trusted Node host.

The package requires Node.js 24.15 or newer.

## Choose the package

| Project                              | Install                      | Import from                                                               |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------- |
| A ViteHub application                | `pnpm add vite-hub`          | `vite-hub/browser` and `vite-hub/browser/actions`                         |
| A direct Vite integration or library | `pnpm add @vite-hub/browser` | `@vite-hub/browser`, its `/actions` subpath, and `@vite-hub/browser/vite` |

Use `vite-hub` for normal application code. It includes this package and keeps the Browser integration with the rest of the ViteHub deployment.

Install `@vite-hub/browser` directly when you compose Vite integrations yourself or need explicit providers and controllers. Choose one import family for application code so its package dependency stays clear.

## Get rendered HTML

Enable Browser on a Cloudflare deployment:

```ts
// vite.config.ts
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

Call a stateless action from trusted server code:

```ts
import { runBrowserContent } from "vite-hub/browser/actions"

export async function checkExampleDomain() {
  const [error, html] = await runBrowserContent("https://example.com")
  if (error) throw error

  return { found: html.includes("<h1>Example Domain</h1>") }
}
```

Calling `checkExampleDomain()` through a server route, Queue, or Workflow returns:

```json
{ "found": true }
```

This example uses a fixed public URL. If a request supplies the destination, do not rely on validating only the initial URL. Enforce protocol, host, and resolved-address policy for every browser network request, including redirects and subresources, or restrict browser egress at the provider or network boundary. A browser can send requests to every destination its provider can reach, and the returned page is untrusted input.

ViteHub writes the Cloudflare Browser binding and required compatibility fields to generated Provider Output. The action runs only where that binding is available. For local Wrangler development that must call the hosted Browser Run service, configure `browser: { remote: true }`. This uses a Cloudflare account and network access; it does not switch Browser Definitions to the local Chromium provider.

## Reuse a named operation

Use a Browser Definition when several callers need the same input and result contract. Place the file in `server/browsers/` or name it `*.browser.ts`:

```ts
// server/browsers/page-content.ts
import { defineBrowser } from "vite-hub/browser"

export default defineBrowser(async (input: { url: string }, { browser }) => {
  return await browser.content(input.url)
})
```

Run the discovered Definition by name:

```ts
import { runBrowser } from "vite-hub/browser"

const [error, html] = await runBrowser("page-content", {
  url: "https://example.com",
})
if (error) throw error

console.log(html.includes("<h1>Example Domain</h1>")) // true
```

The generated Browser registry infers the Definition's input and result types. `runBrowser()` returns an error-first result with a stable `BROWSER_*` code when discovery or provider execution fails.

Keep target validation beside the route or job that accepts the URL. A reusable Definition does not make an untrusted destination safe.

## Keep one page for several interactions

Use `browser.open()` inside a Definition when one operation needs navigation, form input, or several reads from the same page:

```ts
import { defineBrowser } from "vite-hub/browser"

export default defineBrowser(async (input: { url: string }, { browser }) => {
  const session = await browser.open()
  await session.page.goto(input.url)
  await session.page.locator("h1").waitFor()
  return await session.page.locator("h1").count()
})
```

ViteHub releases the controller and closes Definition-owned sessions after the handler succeeds or fails. Call `session.close()` when the operation can release the session sooner.

The default Kitesurf engine uses the Browser binding and does not support live handoff. Set `browser: { engine: "chromium" }` for a persistent Cloudflare Chromium session. That path requires the optional `@cloudflare/playwright` and `playwright-core` peers.

Browser sessions can observe authenticated pages, cookies, network responses, screenshots, and rendered private UI. Do not log provider session ids, CDP endpoints, authorization headers, cookies, or handoff references. Apply the application's access, retention, and deletion rules to screenshots and downloads.

## Use the owner package directly

When another server build already composes Vite and Cloudflare output, register the package integration directly:

```bash
pnpm add @vite-hub/browser vite
```

```ts
// vite.config.ts
import { hubBrowser } from "@vite-hub/browser/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubBrowser()],
})
```

Use `@vite-hub/browser` and `@vite-hub/browser/actions` in the corresponding server code. `hubBrowser()` discovers Browser Definitions and writes Cloudflare Browser Provider Output. It does not deploy the Worker, authenticate Cloudflare, or select a local browser.

## Manage a local Chromium process

`createBrowser()` is the low-level interface for a caller that owns provider selection, controller attachment, and cleanup. The local provider starts the supplied Chromium executable on the current trusted Node host.

```bash
pnpm add @vite-hub/browser playwright-core
```

```ts
import { createBrowser } from "@vite-hub/browser"
import { playwright } from "@vite-hub/browser/controllers/playwright"
import { localBrowser } from "@vite-hub/browser/providers/local"

const browser = createBrowser({
  provider: localBrowser({ executablePath: "/usr/bin/chromium" }),
})
const session = await browser.open()

try {
  const control = await session.attach(playwright())

  try {
    await control.client.page.goto("https://example.com")
    console.log(await control.client.page.title()) // Example Domain
  } finally {
    await control.release()
  }
} finally {
  await session.close()
}
```

Set `executablePath` to an installed Chromium-compatible browser. The path above is a Linux example. `playwright-core` supplies the controller but does not download a browser.

Use this adapter only when the process is allowed to start Chromium and isolate it according to the host's threat model. It uses a temporary browser profile and removes that profile when the session closes. ViteHub does not provide an untrusted-code sandbox around the browser process.

Low-level Cloudflare sessions can also transfer an exact provider session through an audience-bound live handoff reference. Handoff requires the persistent Chromium engine. The receiver must claim the reference through the same `createBrowser()` client that created the session; references do not cross clients or processes. A handed-off session is not closed for the original caller. Treat the reference as a short-lived credential and close the claimed session when its work finishes.

## Production checks

- Keep Browser calls in trusted server code. Give an Agent the narrower `browser()` Capability instead of exposing raw provider or controller access.
- Inspect the generated Cloudflare `wrangler.json` before deployment. It is Provider Output, not an application import or a file to edit by hand.
- Test the deployed Worker when the result depends on Browser Run bindings. A successful package build proves imports and generated output, not provider availability.
- Handle `BROWSER_*` failures at the route, Queue, or Workflow that can retry, reject input, or report the failure.

Read the [Browser guide](https://vitehub.dev/docs/server-primitives/browser) for configuration, actions, sessions, and live handoff. See [Cloudflare deployment](https://vitehub.dev/docs/frameworks-hosts/cloudflare) for the generated binding and local Wrangler choices.
