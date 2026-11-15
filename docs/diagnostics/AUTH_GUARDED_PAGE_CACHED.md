---
description: "Fix AUTH_GUARDED_PAGE_CACHED in ViteHub when a route rule caches or prerenders a guarded Nuxt page. Remove the cache or turn it off for the page."
seo.title: "AUTH_GUARDED_PAGE_CACHED: guarded page cache"
---

A route rule caches or prerenders a Nuxt page that `definePageMeta({ auth })` guards. The build stops before Nitro bundles the server. With the Vite builder, it also stops before Nitro prerenders pages. The page guard runs when the server renders a page. A cached or prerendered page keeps the render or the redirect of one visitor and serves it to all visitors.

## Why it happens

A page is guarded when `definePageMeta()` sets `auth` to a value other than `false`. A child page without `auth` gets the `auth` of its parent page. The check reads the page that Vue Router selects for a path: a parent page with an empty child path, such as `pages/dashboard/index.vue`, gets the `auth` of that child on its own path.

`swr`, `cache`, `isr`, `prerender`, and `static` cache a page. The message names the route rule, the rule that caches, the request method, and the guarded page. The check compares route patterns, so a rule counts when it caches at least one guarded page. For example, `'/**': { prerender: true }` covers a guarded `/dashboard` page. Nuxt renders the payload of a page at `<page>/_payload.json`, so the check reads the page and its payload separately. A rule on `/dashboard` does not turn off a cache on `/dashboard/_payload.json`, and a rule on the payload does not turn off a cache on the page. `'/dashboard/**'` matches both. When the Nuxt router is not case sensitive, which is the default, the check compares paths without case, as Nuxt matches route rules.

A rule that turns the cache off must match every guarded page, or every page of the rule that caches. `'/dashboard': { cache: false }` does not turn off `'/dashboard/**': { swr: 60 }` for a guarded `/dashboard/report` page.

Three cases do not stop the build:

- A route rule key that is the static path of a public page, or the payload of that path. For example, `'/users/public': { swr: 60 }` and `'/users/public/_payload.json': { swr: 60 }` beside a guarded `/users/[id]` page. Vue Router selects the static page first. A public page with a dynamic path, such as `/users/user-[id]` or a catch-all, does not exempt a rule. A wider key, such as `'/users/**'`, also stops the build when it matches a guarded page.
- `prerender` on a guest page, such as `auth: 'guest'` on the login page. Nuxt prerenders the page without a cookie, so the page renders for a signed-out visitor. In the browser, the page guard reads the session again and sends a signed-in user away. `swr`, `cache`, `isr`, and `static` still stop the build, because they keep the render of the first visitor, who can be signed in.
- A path that Nuxt renders only in the browser: `ssr: false` in the Nuxt config, or an `ssr: false` route rule that matches every path that the rule caches on the page, for the same request method. The server then sends the same empty shell to every visitor. An `ssr: true` rule that h3 merges later on these paths turns server rendering on again.

## Fix it

To fix the build, do one of these:

- Remove the rule that caches from the route rule that the message names.
- Add a route rule for the guarded pages and their payloads that turns the cache off, for example `'/dashboard/**': { cache: false, prerender: false }`.
- To keep the cache, add `ssr: false` to the route rule of the guarded pages. The page guard then runs only in the browser.
- If the page is public, remove its page guard.
- To cache one public path beside a guarded page, add a public page with that static path, for example `pages/users/public.vue` with `definePageMeta({ auth: false })`. Then use that exact path as the route rule key, for example `'/users/public': { swr: 60 }`.

The check reads `auth` only when `definePageMeta()` sets it to a literal value, such as `'user'` or `{ only: 'user' }`. It does not read a page that gets `auth` from a variable, or a page when `experimental.scanPageMeta` is `false`.
