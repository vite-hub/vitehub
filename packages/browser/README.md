# `@vite-hub/browser`

[![npm version](https://img.shields.io/npm/v/@vite-hub/browser)](https://npmx.dev/package/@vite-hub/browser)
[![npm downloads](https://img.shields.io/npm/dm/@vite-hub/browser)](https://npmx.dev/package/@vite-hub/browser)
[![license](https://img.shields.io/static/v1?label=license&message=Apache-2.0&color=blue)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://img.shields.io/static/v1?label=docs&message=vitehub.dev&color=blue)](https://vitehub.dev/docs)

`@vite-hub/browser` runs trusted server-side browser work through named Browser Definitions, stateless actions, or caller-managed sessions.

Browser Definitions pick a driver from the host: Cloudflare Browser Run on Cloudflare, a local Chromium on Node, Docker, and in dev, and a remote Chromium over CDP on Vercel.

The package requires Node.js 24.15 or newer.

## Choose the package

| Project                              | Install                                | Import from                                      |
| ------------------------------------ | -------------------------------------- | ------------------------------------------------ |
| A ViteHub application                | `pnpm add vite-hub @vite-hub/browser`  | `vite-hub/browser`                               |
| A direct Vite integration or library | `pnpm add @vite-hub/browser`           | `@vite-hub/browser` and `@vite-hub/browser/vite` |

Use `vite-hub` with `@vite-hub/browser` for normal application code. `vite-hub` declares `@vite-hub/browser` as an optional peer dependency and keeps the Browser integration with the rest of the ViteHub deployment.

Install `@vite-hub/browser` directly when you compose Vite integrations yourself or need explicit providers and controllers. Choose one import family for application code so its package dependency stays clear.

## Choose the driver

`browser: true` picks the driver from the host:

| Host | Driver | What to set |
| --- | --- | --- |
| Cloudflare | Browser Run | Nothing. ViteHub writes the Browser binding to `wrangler.json`. |
| Node and Docker | Local Chromium | Install Chromium. ViteHub finds it, or reads `BROWSER_EXECUTABLE_PATH`. |
| Vercel | Remote Chromium | `BROWSER_CDP_URL`, a Browserless or Browserbase WebSocket URL. |
| Dev | Local Chromium | The same as Node. `remote: true` uses Browser Run in Cloudflare dev. |

Netlify and Deno have no driver, and `browser: true` fails the build there.

On Node, `BROWSER_CDP_URL` wins over the local Chromium. A `ws://` or `wss://` URL is the browser WebSocket. An `http://` or `https://` URL is a Chromium with `--remote-debugging-port`, and each session opens and closes its own page there. The URL can hold a token, so keep it in a secret.

Local Chromium checks `BROWSER_EXECUTABLE_PATH`, then the newest Chromium that `npx playwright install chromium` downloaded, then a system Chromium such as `/usr/bin/chromium`. When it finds none, the call fails with `BROWSER_CHROMIUM_NOT_FOUND` and the fix. In a Docker image, run `apt-get install -y chromium`. A root process runs Chromium without its sandbox, because Chromium refuses it as root. When the host blocks the sandbox, the call fails with `BROWSER_CHROMIUM_SANDBOX_UNAVAILABLE`; on a trusted host, set `BROWSER_SANDBOX=false`.

Off Cloudflare, `runBrowserContent()` opens the URL in a page and returns its HTML. The other quick actions need Browser Run and fail with `BROWSER_QUICK_ACTION_REQUIRES_BROWSER_RUN`.

## Get rendered HTML

Enable Browser on a Cloudflare deployment:

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      host: "cloudflare",
      browser: true,
    }),
  ],
})
```

Call a stateless action from trusted server code:

```ts
import { runBrowserContent } from "vite-hub/browser"

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

ViteHub writes the Cloudflare Browser binding and required compatibility fields to generated Provider Output. The action runs only where that binding is available. In Cloudflare dev, Browser Definitions use local Chromium. For local Wrangler development that must call the hosted Browser Run service, configure `browser: { remote: true }`. This uses a Cloudflare account and network access.

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

The generated Browser registry infers the Definition's input and result types. `runBrowser()` returns `[error, data]`, where `data` is the value that the handler returned. An unknown name returns `BROWSER_DEFINITION_NOT_FOUND`, and a failed handler or provider returns `BROWSER_RUN_FAILED` with the error in `error.cause`. A build without Browser throws `BROWSER_UNAVAILABLE`. `runBrowserContent()` returns `[error, html]`, with `BROWSER_CONTENT_FAILED` for a failed request. In a route, `return toResponse(error)` from `vite-hub/runtime` answers with the status of the error.

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

The default Kitesurf engine uses the Browser binding and does not support live handoff. Set `browser: { engine: "chromium" }` for a persistent Cloudflare Chromium session. That path requires the optional `@cloudflare/playwright` and `playwright-core` peers. The `playwright()` controller uses Cloudflare's adapter in Workers. Builds with the `workerd` export condition exclude the Node Playwright loader. The built-in Playwright CDP adapter requires Node.js.

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

Use `@vite-hub/browser` in the corresponding server code. `hubBrowser()` discovers Browser Definitions, selects the driver from the Nitro preset, and writes Cloudflare Browser Provider Output for a Cloudflare build. It does not deploy the Worker or authenticate Cloudflare.

## Manage a local Chromium process

`createBrowser()` is the low-level interface for a caller that owns driver selection, controller attachment, and cleanup. The local driver starts the supplied Chromium executable on the current trusted Node host.

```bash
pnpm add @vite-hub/browser playwright-core
```

```ts
import { createBrowser } from "@vite-hub/browser"
import { playwright } from "@vite-hub/browser/controllers/playwright"
import { localBrowser } from "@vite-hub/browser/providers/local"

const browser = createBrowser({
  driver: localBrowser({ executablePath: "/usr/bin/chromium" }),
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

Set `executablePath` to an installed Chromium-compatible browser, or remove it to find one as Browser Definitions do. The path above is a Linux example. `sandbox: false` runs Chromium without its sandbox. Use `cdpBrowser({ url })` from `@vite-hub/browser/providers/cdp` for a remote Chromium. `playwright-core` supplies the controller but does not download a browser. The local provider rejects `idleTimeoutMs`, from `open()` or `policy`, because nothing closes an idle local Chromium. Close the session yourself.

If reading the controller client or attachment tracing fails, ViteHub releases the attached controller before rejecting `session.attach()`. If that release also fails, the session keeps controller ownership and rejects another attachment or handoff. Call `session.close()` to retry failed rollback cleanup before terminating the provider session. Closure waits for pending controller rollback cleanup before terminating the provider; if it fails again, closure rejects and can be retried. Detach tracing does not delay provider termination after controller cleanup succeeds.

Concurrent `control.release()` calls wait for the same cleanup. If controller cleanup fails, the session keeps controller ownership and rejects another attachment or handoff. Retry `control.release()` or call `session.close()` to terminate the provider session. If the detach trace fails after cleanup succeeds, `control.release()` rejects with controller ownership already cleared.

Use this adapter only when the process is allowed to start Chromium and isolate it according to the host's threat model. It uses a temporary browser profile and removes that profile when the session closes. ViteHub does not provide an untrusted-code sandbox around the browser process.

Low-level Cloudflare sessions can also transfer an exact provider session through an audience-bound live handoff reference. Handoff requires the persistent Chromium engine. The receiver must claim the reference through the same `createBrowser()` client that created the session; references do not cross clients or processes. A handed-off session is not closed for the original caller. Treat the reference as a short-lived credential and close the claimed session when its work finishes.

Handoff references expire after 60 seconds by default. Set `policy.handoffTtl` or pass `ttl` to `session.handoff()` to change this duration. The value must be greater than zero and no greater than 2,147,483,647 milliseconds, the runtime timer limit.

## Production checks

- Keep Browser calls in trusted server code. For Provider Agent browser work, add the `browser()` Capability. With the default command, it installs and validates a pinned `agent-browser` CLI and Chromium runtime when the Driver does not set `launch`. A Driver with `launch` uses the external runtime and skips local browser installation. Allow installation downloads and a writable runtime cache on the Agent host when the managed runtime is selected.
- Use `browser({ runtime: "external" })` when you provision the CLI and browser yourself. An unset runtime also selects external mode when the Driver has `launch`, and a custom `command` selects external mode by default. Use `browser({ runtime: "managed" })` only when the Driver does not launch work elsewhere. The Capability supplies workspace instructions for the Agent's existing shell; it does not narrow shell authority or expose this Browser primitive.
- Inspect the generated Cloudflare `wrangler.json` before deployment. It is Provider Output, not an application import or a file to edit by hand.
- On Node, check that the server image has Chromium. On Vercel, check that `BROWSER_CDP_URL` is set for the environment.
- Test the deployed Worker when the result depends on Browser Run bindings. A successful package build proves imports and generated output, not provider availability.
- Handle `BROWSER_*` failures at the route, Queue, or Workflow that can retry, reject input, or report the failure.

Read the [Browser guide](https://vitehub.dev/docs/browser) for configuration, actions, sessions, and live handoff. See [Cloudflare deployment](https://vitehub.dev/docs/frameworks-hosts/cloudflare) for the generated binding and local Wrangler choices.
