---
title: Browser limits and errors
description: Browser timeouts, handoff limits, and production checks.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

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
