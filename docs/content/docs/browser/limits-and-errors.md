---
title: Browser limits and errors
description: Browser action timeouts, live handoff limits, engine differences, and checks before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

- Browser Definitions run on Cloudflare, Node, and Vercel, and in dev. Netlify and Deno have no Browser driver.
- Off Cloudflare, the only quick action is `runBrowserContent()`. The others need Browser Run.
- A Browser action waits 30 seconds by default. Timeout fields in the action input raise this to at most 6 minutes plus 30 seconds of grace.
- The Kitesurf engine has no idle timeout and no live handoff.
- Handoff refs expire after 60 seconds by default. Change it with `policy.handoffTtl` on `createBrowser()` or `ttl` on `session.handoff()`.

## Errors

### BROWSER_UNAVAILABLE

The build does not turn on Browser, so a Browser Definition or action cannot run. `runBrowserAction()` returns it in a `500` response, and `runBrowserContent()` returns `BROWSER_CONTENT_FAILED`. `runBrowser()` and `browser.open()` in a Definition throw it, because it is a config error. `error.details` has the `host`, the `reason`, and the `fix`. On Cloudflare, Node, and Vercel, set `browser: true` in `vitehub()`. Netlify and Deno have no Browser driver, so check `isBrowserAvailable()` first. See [Builds without Browser](/docs/browser/hosts#builds-without-browser).

See [Browser diagnostics](/docs/browser/diagnostics) for driver errors and fixes.

## Production checks

Run browser automation only from trusted server code. A session can see logged-in pages, cookies, screenshots, network responses, and private UI.

> [!WARNING]
> When a request gives the URL, checking only the first URL is not enough. Check the protocol, host, and resolved address of every request, including redirects and subresources, or limit network access at the provider. Treat the page as untrusted input.

Do not log provider session ids, CDP endpoints, cookies, authorization headers, or raw handoff refs. Screenshots and downloads are user data: apply your artifact storage, retention, and approval rules.

On Cloudflare, inspect the generated `wrangler.json` before you deploy. On Node, check that the server image has Chromium. On Vercel, check that `BROWSER_CDP_URL` is set. Then test the deployed app. A good build proves imports and generated output, not that the provider works. Run `vitehub inspect definitions` to list Browser Definitions.
