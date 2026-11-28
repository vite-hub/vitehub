---
description: "Fix BROWSER_CONTENT_FAILED in ViteHub. runBrowserContent() could not read the page HTML from Browser Run."
seo.title: "BROWSER_CONTENT_FAILED: Browser content request failed"
---

`runBrowserContent()` returns `BROWSER_CONTENT_FAILED` when it cannot read the page HTML. A failed handler that calls it returns `BROWSER_RUN_FAILED` with this error in `error.cause`.

## Why it happens

- Browser Run answered with an error, such as `422` when the page URL does not resolve.
- The request did not reach Browser Run. The Browser binding is missing, for example in `vite dev`, or the build does not turn on Browser (`BROWSER_UNAVAILABLE`).

The message has only the HTTP status. The reason is in `error.cause`: the JSON error body from Browser Run, or the error from before the request.

## Fix it

Read `error.cause` on the server:

```ts [server/api/page.get.ts]
import { runBrowserContent } from 'vite-hub/browser'
import { toResponse } from 'vite-hub/runtime'

export default {
  async fetch() {
    const [error, html] = await runBrowserContent('https://example.com')
    if (error) {
      console.error(error.cause)
      return toResponse(error)
    }
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  },
}
```

Then fix the URL or the input that the cause names, or the Browser configuration. Do not send `error.cause` to clients: it can contain credentials from the target URL. `toResponse()` omits it.

## Related

- [Server API](/docs/browser/server-api)
- [Builds without Browser](/docs/browser/hosts#builds-without-browser)
