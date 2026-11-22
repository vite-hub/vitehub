# @vite-hub/auth decisions

## Read the SSR session at the page origin with the build's Auth mount path

`pageFetch` and `fetchServerSession` in `packages/auth/src/runtime/vue-nuxt.ts`.

**Context:** Better Auth uses secure cookie names on HTTPS. Nitro mounts the Auth handler at the build's base path, which can differ from Nuxt's runtime page base URL.

**Decision:** Request the session in-process at the page's origin and the build's Auth mount path. Keep the path on that origin even when it begins with `//`, and forward the request context used for rate limits and bindings.

**Consequences:** An HTTPS page reads the same session as its browser. Using the runtime page base URL can render a page instead of reaching Auth and recurse into another session lookup.
