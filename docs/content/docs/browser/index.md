---
title: Browser
navigation.title: Overview
description: Define provider-backed browser operations without exposing provider setup to application code.
navigation.order: 1
icon: i-lucide-monitor
---

::agent-only{skill="browser"}
Use Browser for provider-backed browser actions that need a remote session. Browser Definitions keep provider setup out of application code and make each run explicit.

Read [Get started](/docs/browser/get-started). Check [Hosts](/docs/browser/hosts) before choosing a provider.

Browser Definitions currently use Cloudflare Browser Run. Keep credentials and session authority in the host configuration. Do not treat a browser screenshot or page as trusted application data without validation.

Remote pages are untrusted input and may leave the allowed origin or change
between runs. Validate URLs, extracted data, and side effects in application
code.

Prove one complete run, including session cleanup and the provider binding in generated output.
::

::product-hero{tagline="Name a browser operation and run it from a route, Queue, or Workflow, with no Cloudflare imports or credentials." hosts="Cloudflare"}
  :::code-group
  ```ts [Definition and route]
  // server/browsers/page-title.ts
  import { defineBrowser } from 'vite-hub/browser'

  export default defineBrowser(async (input: { url: string }, { browser }) => {
    const session = await browser.open()
    await session.page.goto(input.url)
    await session.page.locator('main').waitFor()
    return await session.page.locator('h1').count()
  })

  // server/api/page-title.post.ts
  import { runBrowser } from 'vite-hub/browser'

  export default defineEventHandler(async (event) => {
    const input = await readBody<{ url: string }>(event)
    return await runBrowser('page-title', input)
  })
  ```

  ```ts [vite.config.ts]
  import { vitehub } from 'vite-hub'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [
      vitehub({
        preset: 'cloudflare',
        browser: {
          binding: 'RENDER_BROWSER',
          remote: true,
        },
      }),
    ],
  })
  ```

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { browser } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { kind: 'codex', model: 'gpt-6-astra' },
    workspace: { mode: 'write' },
    capabilities: [browser()],
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="One file per browser operation" icon="i-lucide-code-2" to="/docs/browser/server-api"}
  `runBrowser()` runs a Definition with inferred input and returns a `Response`.
  :::

  :::product-feature-item{title="Several interactions share one page" icon="i-lucide-monitor" to="/docs/browser/server-api#keep-a-page-session-open"}
  `browser.open()` gives a page session that ViteHub closes for you.
  :::

  :::product-feature-item{title="One stateless call needs no Definition" icon="i-lucide-play-circle" to="/docs/browser/server-api#browser-actions"}
  Content, Markdown, links, screenshot, or PDF through `runBrowserAction()`.
  :::

  :::product-feature-item{title="Enable it on the Cloudflare preset" icon="i-lucide-cloud-cog" to="/docs/browser/configure"}
  `browser: true` writes the Browser Run binding to `wrangler.json`.
  :::

  :::product-feature-item{title="A Provider Agent gets its own browser CLI" icon="i-lucide-bot" to="/docs/browser/agent-capability"}
  `browser()` gives a Provider Agent the `agent-browser` CLI and Chromium.
  :::

  :::product-feature-item{title="Model-backed Agents need a custom Capability" icon="i-lucide-plug" to="/docs/agents/capabilities/custom"}
  Write a custom Capability that calls `runBrowser()`.
  :::
::
