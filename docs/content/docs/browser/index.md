---
title: Browser
navigation.title: Overview
description: Load and control web pages in a Cloudflare browser from your server code, with no browser setup in your app.
navigation.order: 1
icon: i-lucide-monitor
---

::product-hero{tagline="Open web pages in a cloud browser from your server, and get back HTML, screenshots, or data." hosts="Cloudflare"}
  :::product-files
  ```ts [server/browsers/page-html.ts]
  import { defineBrowser } from 'vite-hub/browser'

  // Returns the HTML of a page after it renders
  export default defineBrowser(async (
    input: { url: string },
    { browser },
  ) => {
    return await browser.content(input.url)
  })
  ```

  ```ts [server/browsers/headings.ts]
  import { defineBrowser } from 'vite-hub/browser'

  // Keep one page open for several steps
  export default defineBrowser(async (
    input: { url: string },
    { browser },
  ) => {
    const session = await browser.open()
    await session.page.goto(input.url)
    await session.page.locator('main').waitFor()
    return await session.page.locator('h1').count()
  })
  ```

  ```ts [server/api/page-html.post.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { runBrowser } from 'vite-hub/browser'

  // Run the page-html file by its name
  export default defineEventHandler(async (event) => {
    const input = await readBody<{ url: string }>(event)
    return await runBrowser('page-html', input)
  })
  ```

  ```ts [server/api/screenshot.get.ts]
  import { defineEventHandler } from 'h3'
  import {
    runBrowserAction,
  } from 'vite-hub/browser/actions'

  // One call, no browser file needed
  export default defineEventHandler(() => {
    return runBrowserAction(
      'screenshot',
      'https://example.com',
    )
  })
  ```

  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  // Adds the Cloudflare browser setting for you
  export default defineConfig({
    plugins: [
      vitehub({ preset: 'cloudflare', browser: true }),
    ],
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="One file per task" icon="i-lucide-file-code-2" to="/docs/browser/server-api#definition-api"}
  Add a file to `server/browsers`. Run it by its name with `runBrowser()`.
  :::

  :::product-feature-item{title="Several steps on one page" icon="i-lucide-mouse-pointer-click" to="/docs/browser/server-api#keep-a-page-session-open"}
  `browser.open()` keeps a page open to go to links, click, and fill in forms. ViteHub closes it for you.
  :::

  :::product-feature-item{title="Quick calls without a file" icon="i-lucide-zap" to="/docs/browser/server-api#browser-actions"}
  Get HTML, Markdown, links, a screenshot, or a PDF with one function call.
  :::

  :::product-feature-item{title="No browser setup in your app" icon="i-lucide-cloud-cog" to="/docs/browser/configure#configuration"}
  `browser: true` adds the Cloudflare setting at build time. Your routes do not import Cloudflare code.
  :::

  :::product-feature-item{title="Full control when you need it" icon="i-lucide-sliders-horizontal" to="/docs/browser/server-api#low-level-sessions"}
  Use Playwright, or a local Chromium on a Node server that you trust.
  :::

  :::product-feature-item{title="Check the URLs you open" icon="i-lucide-shield-check" to="/docs/browser/limits-and-errors#production-checks"}
  Check every URL that users send you. Treat the content of each page as untrusted.
  :::
::
